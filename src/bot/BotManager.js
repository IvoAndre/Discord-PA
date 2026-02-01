const EventEmitter = require('events');
const { PassThrough } = require('stream');
const { Client, GatewayIntentBits } = require('discord.js');
const { 
    joinVoiceChannel, 
    getVoiceConnection,
    createAudioPlayer, 
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType
} = require('@discordjs/voice');

// Flag de debug
const DEBUG_MODE = process.argv.includes('--debug') || process.env.DEBUG === 'true';

class BotManager extends EventEmitter {
    constructor() {
        super();
        this.bots = [];
        this.sourceStream = null;
        this.streamBranches = new Map(); // connectionId -> PassThrough
        this.presetChannels = new Map(); // `${botIndex}-${guildId}` -> channelId
        
        // Voice Activity Detection (VAD) settings
        this.vadEnabled = true;           // Ativar/desativar VAD
        this.vadThreshold = 1;           // Threshold baixo para silêncio absoluto
        this.vadSilenceTimeout = 500;     // ms de silêncio antes de parar
        this.vadCheckInterval = 100;      // ms entre verificações (debounce)
        this._isSpeaking = false;
        this._silenceStartTime = null;
        this._lastSpeakingState = false;
        this._lastVadCheck = 0;           // Timestamp da última verificação
        this._consecutiveSilence = 0;     // Contador de frames de silêncio consecutivos
        this._consecutiveSound = 0;       // Contador de frames de som consecutivos
    }
    
    // Guardar canal predefinido para um bot num servidor
    setPresetChannel(botIndex, guildId, channelId) {
        const key = `${botIndex}-${guildId}`;
        if (channelId) {
            this.presetChannels.set(key, channelId);
            console.log(`[Bot] Canal predefinido guardado: Bot ${botIndex}, Servidor ${guildId}, Canal ${channelId}`);
        } else {
            this.presetChannels.delete(key);
        }
        this.emit('statusChange');
    }
    
    // Obter canal predefinido
    getPresetChannel(botIndex, guildId) {
        return this.presetChannels.get(`${botIndex}-${guildId}`);
    }
    
    // Obter todas as predefinições
    getPresetChannels() {
        const presets = [];
        for (const [key, channelId] of this.presetChannels) {
            const [botIndex, guildId] = key.split('-');
            const bot = this.bots[parseInt(botIndex)];
            if (bot && bot.ready) {
                const guild = bot.client.guilds.cache.get(guildId);
                const channel = guild?.channels.cache.get(channelId);
                presets.push({
                    botIndex: parseInt(botIndex),
                    botName: bot.username,
                    guildId,
                    guildName: guild?.name || 'Desconhecido',
                    channelId,
                    channelName: channel?.name || 'Desconhecido'
                });
            }
        }
        return presets;
    }
    
    // Entrar em todos os canais predefinidos
    async joinAllPresetChannels() {
        const results = [];
        for (const [key, channelId] of this.presetChannels) {
            const [botIndex, guildId] = key.split('-');
            try {
                await this.joinChannel(parseInt(botIndex), guildId, channelId);
                results.push({ success: true, botIndex, guildId, channelId });
            } catch (error) {
                console.error(`[Bot] Erro ao entrar no canal predefinido:`, error.message);
                results.push({ success: false, botIndex, guildId, channelId, error: error.message });
            }
        }
        return results;
    }
    
    // Sair de todos os canais
    async leaveAllChannels() {
        for (let i = 0; i < this.bots.length; i++) {
            const bot = this.bots[i];
            const guildIds = Array.from(bot.connections.keys());
            for (const guildId of guildIds) {
                await this.leaveChannel(i, guildId);
            }
        }
    }
    
    async addBot(token) {
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates
            ]
        });
        
        const botInfo = {
            client,
            token,
            ready: false,
            connections: new Map(), // guildId -> connection
            players: new Map(), // guildId -> player
            username: null,
            avatar: null,
            id: null
        };
        
        // Usar Client#ready para compatibilidade
        const onReady = () => {
            botInfo.ready = true;
            botInfo.username = client.user.username;
            botInfo.avatar = client.user.displayAvatarURL();
            botInfo.id = client.user.id;
            console.log(`[Bot] ${client.user.tag} está online!`);
            this.emit('statusChange');
        };
        
        // Suportar tanto 'ready' como 'clientReady' para futuras versões
        if (client.isReady()) {
            onReady();
        } else {
            client.once('ready', onReady);
        }
        
        client.on('error', (error) => {
            console.error(`[Bot] Erro:`, error);
        });
        
        client.on('voiceStateUpdate', (oldState, newState) => {
            // Re-emitir mudanças de estado
            this.emit('statusChange');
        });
        
        await client.login(token);
        this.bots.push(botInfo);
        
        return botInfo;
    }
    
    getBotsStatus() {
        return this.bots.map((bot, index) => ({
            index,
            ready: bot.ready,
            username: bot.username,
            avatar: bot.avatar,
            id: bot.id,
            connections: Array.from(bot.connections.entries()).map(([guildId, conn]) => {
                const guild = bot.client.guilds.cache.get(guildId);
                const channel = conn.joinConfig?.channelId 
                    ? guild?.channels.cache.get(conn.joinConfig.channelId) 
                    : null;
                return {
                    guildId,
                    guildName: guild?.name || 'Desconhecido',
                    channelId: conn.joinConfig?.channelId,
                    channelName: channel?.name || 'Desconhecido',
                    status: conn.state?.status || 'unknown'
                };
            })
        }));
    }
    
    getGuilds(botIndex = null) {
        const guildsMap = new Map();
        
        // Se botIndex for especificado, usar apenas esse bot
        const botsToCheck = botIndex !== null && this.bots[botIndex] 
            ? [this.bots[botIndex]] 
            : this.bots;
        
        for (const bot of botsToCheck) {
            if (!bot.ready) continue;
            
            for (const [guildId, guild] of bot.client.guilds.cache) {
                if (!guildsMap.has(guildId)) {
                    guildsMap.set(guildId, {
                        id: guildId,
                        name: guild.name,
                        icon: guild.iconURL()
                    });
                }
            }
        }
        
        return Array.from(guildsMap.values());
    }
    
    getVoiceChannels(guildId) {
        for (const bot of this.bots) {
            if (!bot.ready) continue;
            
            const guild = bot.client.guilds.cache.get(guildId);
            if (guild) {
                return guild.channels.cache
                    .filter(ch => ch.type === 2) // GuildVoice
                    .map(ch => ({
                        id: ch.id,
                        name: ch.name,
                        memberCount: ch.members.size
                    }));
            }
        }
        return [];
    }
    
    async joinChannel(botIndex, guildId, channelId) {
        const bot = this.bots[botIndex];
        if (!bot || !bot.ready) {
            throw new Error('Bot não está disponível');
        }
        
        const guild = bot.client.guilds.cache.get(guildId);
        if (!guild) {
            throw new Error('Servidor não encontrado');
        }
        
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            throw new Error('Canal não encontrado');
        }
        
        // Desconectar do canal anterior se existir (com verificação de estado)
        if (bot.connections.has(guildId)) {
            const oldConn = bot.connections.get(guildId);
            try {
                if (oldConn.state.status !== VoiceConnectionStatus.Destroyed) {
                    oldConn.destroy();
                }
            } catch (e) {
                // Ignorar erro se já destruída
            }
            bot.connections.delete(guildId);
            bot.players.delete(guildId);
        }
        
        // Usar um group único por bot para evitar conflitos entre bots
        const groupId = `bot-${bot.id}`;
        
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
            group: groupId  // Grupo único para cada bot
        });
        
        // Criar player para esta conexão
        const player = createAudioPlayer();
        connection.subscribe(player);
        
        bot.connections.set(guildId, connection);
        bot.players.set(guildId, player);
        
        // Aguardar conexão
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            console.log(`[Bot] ${bot.username} entrou em ${channel.name}`);
        } catch (error) {
            connection.destroy();
            bot.connections.delete(guildId);
            bot.players.delete(guildId);
            throw new Error('Tempo limite ao conectar ao canal de voz');
        }
        
        // Handle disconnection
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
            } catch (error) {
                // Remover da transmissão se estava ativa
                this.removePlayerFromBroadcast(bot.id, guildId);
                
                try {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        connection.destroy();
                    }
                } catch (e) {}
                bot.connections.delete(guildId);
                bot.players.delete(guildId);
                this.emit('statusChange');
            }
        });
        
        // Se já está a transmitir, adicionar este player à transmissão
        if (this.isBroadcasting()) {
            console.log(`[Bot] A adicionar ${bot.username} à transmissão em curso...`);
            this.addPlayerToBroadcast(bot, guildId, player);
        }
        
        this.emit('statusChange');
        this.emit('botJoinedChannel', { botIndex, guildId, channelId });
        return true;
    }
    
    async leaveChannel(botIndex, guildId) {
        const bot = this.bots[botIndex];
        if (!bot) return;
        
        const connection = bot.connections.get(guildId);
        if (connection) {
            // Remover da transmissão primeiro
            this.removePlayerFromBroadcast(bot.id, guildId);
            
            try {
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (e) {
                // Ignorar erro se já destruída
            }
            bot.connections.delete(guildId);
            bot.players.delete(guildId);
            console.log(`[Bot] ${bot.username} saiu do servidor ${guildId}`);
        }
        
        this.emit('statusChange');
    }
    
    // Verificar se há bots conectados a canais
    hasActiveConnections() {
        for (const bot of this.bots) {
            if (bot.connections.size > 0) {
                return true;
            }
        }
        return false;
    }
    
    // Contar conexões ativas
    getActiveConnectionCount() {
        let count = 0;
        for (const bot of this.bots) {
            count += bot.connections.size;
        }
        return count;
    }
    
    // Verificar se está a transmitir
    isBroadcasting() {
        return this.sourceStream !== null && !this.sourceStream.destroyed;
    }
    
    startBroadcast(audioStream) {
        // Verificar se há conexões ativas
        if (!this.hasActiveConnections()) {
            console.warn('[Broadcast] Nenhum bot está conectado a um canal de voz!');
            return false;
        }
        
        // Parar transmissão anterior se existir
        if (this.isBroadcasting()) {
            this.stopBroadcast();
        }
        
        this.sourceStream = audioStream;
        this._isBroadcasting = true;
        
        // Iniciar VAD assumindo que está a falar (para não perder início de som)
        // O VAD vai detetar silêncio e parar se não houver som
        this._isSpeaking = true;
        this._lastSpeakingState = true;
        this._silenceStartTime = null;
        this._lastVadCheck = 0;
        this._consecutiveSilence = 0;
        this._consecutiveSound = 0;
        
        // Buffer de sincronização - acumula dados antes de enviar
        // Isto ajuda a manter todos os bots sincronizados
        const SYNC_BUFFER_SIZE = 3840; // 40ms a 48kHz stereo 16-bit
        let syncBuffer = Buffer.alloc(0);
        
        // Listener para distribuir dados para todas as branches de forma síncrona
        this._dataHandler = (chunk) => {
            if (!this._isBroadcasting) return;
            
            // Acumular no buffer de sincronização
            syncBuffer = Buffer.concat([syncBuffer, chunk]);
            
            // Enviar quando temos dados suficientes
            while (syncBuffer.length >= SYNC_BUFFER_SIZE) {
                const toSend = syncBuffer.slice(0, SYNC_BUFFER_SIZE);
                syncBuffer = syncBuffer.slice(SYNC_BUFFER_SIZE);
                
                // Voice Activity Detection (VAD)
                const now = Date.now();
                const hasSound = this._detectVoiceActivity(toSend);
                
                // Lógica simples: som = transmitir, silêncio prolongado = parar
                if (hasSound) {
                    // Som detetado - transmitir e resetar timer de silêncio
                    this._silenceStartTime = null;
                    
                    if (!this._isSpeaking) {
                        this._isSpeaking = true;
                        if (DEBUG_MODE) console.log('[VAD] 🎤 Som detetado - a transmitir');
                        this.emit('speakingChange', true);
                    }
                } else {
                    // Silêncio detetado
                    if (this._isSpeaking) {
                        if (!this._silenceStartTime) {
                            this._silenceStartTime = now;
                        } else if (now - this._silenceStartTime > this.vadSilenceTimeout) {
                            // Silêncio prolongado - parar transmissão
                            this._isSpeaking = false;
                            if (DEBUG_MODE) console.log('[VAD] 🔇 Silêncio detetado - a pausar');
                            this.emit('speakingChange', false);
                        }
                        // Continuar a transmitir durante o período de silêncio (até timeout)
                    }
                }
                
                // Transmitir se: VAD desativado OU está a falar OU ainda no período de silêncio (antes do timeout)
                const shouldTransmit = !this.vadEnabled || this._isSpeaking || 
                    (this._silenceStartTime && (now - this._silenceStartTime <= this.vadSilenceTimeout));
                
                if (shouldTransmit) {
                    // Enviar para todas as branches ao mesmo tempo
                    const branches = Array.from(this.streamBranches.entries());
                    let transmitted = 0;
                    let recreated = 0;
                    
                    for (const [connectionId, branch] of branches) {
                        // Se o branch foi destruído, recriar
                        if (!branch || branch.destroyed) {
                            // Encontrar o bot e player correspondente
                            const [botId, guildId] = connectionId.split('-');
                            const bot = this.bots.find(b => b.id === botId);
                            if (bot) {
                                const player = bot.players.get(guildId);
                                if (player) {
                                    this._setupBranchForPlayer(bot, guildId, player);
                                    recreated++;
                                    // Tentar enviar para o novo branch
                                    const newBranch = this.streamBranches.get(connectionId);
                                    if (newBranch && !newBranch.destroyed) {
                                        newBranch.write(toSend);
                                        transmitted++;
                                    }
                                }
                            }
                        } else {
                            // Verificar se o buffer interno não está cheio
                            if (branch.writableLength < branch.writableHighWaterMark * 2) {
                                branch.write(toSend);
                                transmitted++;
                            } else {
                                console.warn('[Broadcast] Buffer cheio, a descartar dados para evitar delay');
                            }
                        }
                    }
                    
                    // Log de debug (apenas uma vez por segundo)
                    if (DEBUG_MODE && (!this._lastTransmitLog || now - this._lastTransmitLog > 1000)) {
                        if (recreated > 0) {
                            console.log(`[VAD Debug] Transmitindo para ${transmitted} branches (${recreated} recriados)`);
                        } else {
                            console.log(`[VAD Debug] Transmitindo para ${transmitted} branches`);
                        }
                        this._lastTransmitLog = now;
                    }
                }
                // Quando em silêncio, simplesmente não enviar nada
                // Os branches podem ser destruídos mas serão recriados quando o som voltar
            }
        };
        
        audioStream.on('data', this._dataHandler);
        audioStream.once('end', () => {
            if (this._dataHandler) {
                audioStream.removeListener('data', this._dataHandler);
            }
            this._isBroadcasting = false;
        });
        
        audioStream.once('error', (err) => {
            console.error('[Broadcast] Erro no stream de áudio:', err.message);
            this._isBroadcasting = false;
        });
        
        // Criar branches para todas as conexões ativas
        this._setupAllBranches();
        
        console.log(`[Broadcast] Iniciado para ${this.getActiveConnectionCount()} conexão(ões)`);
        return true;
    }
    
    // Configurar branches para todos os players ativos
    _setupAllBranches() {
        for (const bot of this.bots) {
            for (const [guildId, player] of bot.players) {
                this._setupBranchForPlayer(bot, guildId, player);
            }
        }
    }
    
    // Configurar branch individual para um player
    _setupBranchForPlayer(bot, guildId, player) {
        const connectionId = `${bot.id}-${guildId}`;
        
        // Remover branch anterior se existir
        if (this.streamBranches.has(connectionId)) {
            const oldBranch = this.streamBranches.get(connectionId);
            if (!oldBranch.destroyed) {
                oldBranch.end();
            }
        }
        
        try {
            // Buffer maior para estabilidade (evita cortes)
            const branch = new PassThrough({
                highWaterMark: 19200  // 200ms buffer a 48kHz stereo 16-bit
            });
            this.streamBranches.set(connectionId, branch);
            
            const resource = createAudioResource(branch, {
                inputType: StreamType.Raw,
                inlineVolume: false
            });
            
            player.play(resource);
            if (DEBUG_MODE) console.log(`[Bot] ${bot.username} a transmitir para ${guildId}`);
            return true;
        } catch (error) {
            console.error(`[Bot] Erro ao configurar transmissão:`, error);
            return false;
        }
    }
    
    // Adicionar um novo player à transmissão em curso
    addPlayerToBroadcast(bot, guildId, player) {
        if (!this.isBroadcasting()) {
            return false;
        }
        
        return this._setupBranchForPlayer(bot, guildId, player);
    }
    
    // Remover um player da transmissão
    removePlayerFromBroadcast(botId, guildId) {
        const connectionId = `${botId}-${guildId}`;
        const branch = this.streamBranches.get(connectionId);
        
        if (branch) {
            if (!branch.destroyed) {
                branch.end();
            }
            this.streamBranches.delete(connectionId);
        }
    }
    
    stopBroadcast() {
        this._isBroadcasting = false;
        
        // Remover listener do stream fonte
        if (this.sourceStream && this._dataHandler) {
            this.sourceStream.removeListener('data', this._dataHandler);
        }
        this._dataHandler = null;
        
        // Fechar todas as branches
        for (const branch of this.streamBranches.values()) {
            if (!branch.destroyed) {
                branch.end();
            }
        }
        this.streamBranches.clear();
        this.sourceStream = null;
        
        // Parar todos os players
        for (const bot of this.bots) {
            for (const [guildId, player] of bot.players) {
                try {
                    player.stop();
                } catch (e) {
                    // Ignorar erros ao parar
                }
            }
        }
        
        console.log('[Broadcast] Transmissão parada');
    }
    
    // Detectar atividade de voz (Voice Activity Detection)
    _detectVoiceActivity(audioBuffer) {
        // Audio é PCM 16-bit signed little-endian stereo
        // Calcular RMS (Root Mean Square) do áudio
        let sumSquares = 0;
        const samples = audioBuffer.length / 2; // 2 bytes por sample (16-bit)
        
        for (let i = 0; i < audioBuffer.length; i += 2) {
            // Ler sample como signed 16-bit little-endian
            const sample = audioBuffer.readInt16LE(i);
            sumSquares += sample * sample;
        }
        
        const rms = Math.sqrt(sumSquares / samples);
        
        // Comparar com threshold
        return rms > this.vadThreshold;
    }
    
    // Definir threshold do VAD
    setVadThreshold(threshold) {
        this.vadThreshold = Math.max(0, Math.min(32767, threshold));
        console.log(`[VAD] Threshold definido para: ${this.vadThreshold}`);
    }
    
    // Ativar/desativar VAD
    setVadEnabled(enabled) {
        this.vadEnabled = enabled;
        console.log(`[VAD] ${enabled ? 'Ativado' : 'Desativado'}`);
    }
    
    // Obter estado do VAD
    getVadStatus() {
        return {
            enabled: this.vadEnabled,
            threshold: this.vadThreshold,
            silenceTimeout: this.vadSilenceTimeout,
            isSpeaking: this._isSpeaking
        };
    }
    
    async shutdown() {
        for (const bot of this.bots) {
            // Desconectar de todos os canais
            for (const connection of bot.connections.values()) {
                try {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        connection.destroy();
                    }
                } catch (e) {
                    // Ignorar erro se já destruída
                }
            }
            bot.connections.clear();
            bot.players.clear();
            // Desligar o client
            await bot.client.destroy();
        }
        this.bots = [];
    }
}

module.exports = BotManager;
