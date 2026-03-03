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

// Debug flag
const DEBUG_MODE = process.argv.includes('--debug') || process.env.DEBUG === 'true';

class BotManager extends EventEmitter {
    constructor() {
        super();
        this.bots = [];
        this.sourceStream = null;
        this.streamBranches = new Map(); // connectionId -> PassThrough
        this.presetChannels = new Map(); // `${botIndex}-${guildId}` -> channelId
        
        // Voice Activity Detection (VAD) settings
        this.vadEnabled = true;           // Enable/disable VAD
        this.vadThreshold = 1;           // Low threshold for absolute silence
        this.vadSilenceTimeout = 500;     // ms of silence before stopping
        this.vadCheckInterval = 100;      // ms between checks (debounce)
        this._isSpeaking = false;
        this._silenceStartTime = null;
        this._lastSpeakingState = false;
        this._lastVadCheck = 0;           // Timestamp of last check
        this._consecutiveSilence = 0;     // Consecutive silence frames counter
        this._consecutiveSound = 0;       // Consecutive sound frames counter
    }
    
    // Save preset channel for a bot in a server
    setPresetChannel(botIndex, guildId, channelId) {
        const key = `${botIndex}-${guildId}`;
        if (channelId) {
            this.presetChannels.set(key, channelId);
            console.log(`[Bot] Preset channel saved: Bot ${botIndex}, Server ${guildId}, Channel ${channelId}`);
        } else {
            this.presetChannels.delete(key);
        }
        this.emit('statusChange');
    }
    
    // Get preset channel
    getPresetChannel(botIndex, guildId) {
        return this.presetChannels.get(`${botIndex}-${guildId}`);
    }
    
    // Get all presets
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
                    guildName: guild?.name || 'Unknown',
                    channelId,
                    channelName: channel?.name || 'Unknown'
                });
            }
        }
        return presets;
    }
    
    // Join all preset channels
    async joinAllPresetChannels() {
        const results = [];
        for (const [key, channelId] of this.presetChannels) {
            const [botIndex, guildId] = key.split('-');
            try {
                await this.joinChannel(parseInt(botIndex), guildId, channelId);
                results.push({ success: true, botIndex, guildId, channelId });
            } catch (error) {
                console.error(`[Bot] Error joining preset channel:`, error.message);
                results.push({ success: false, botIndex, guildId, channelId, error: error.message });
            }
        }
        return results;
    }
    
    // Leave all channels
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
        
        // Use Client#ready for compatibility
        const onReady = () => {
            botInfo.ready = true;
            botInfo.username = client.user.username;
            botInfo.avatar = client.user.displayAvatarURL();
            botInfo.id = client.user.id;
            console.log(`[Bot] ${client.user.tag} is online!`);
            this.emit('statusChange');
        };
        
        // Support both 'ready' and 'clientReady' for future versions
        if (client.isReady()) {
            onReady();
        } else {
            client.once('ready', onReady);
        }
        
        client.on('error', (error) => {
            console.error(`[Bot] Error:`, error);
        });
        
        client.on('voiceStateUpdate', (oldState, newState) => {
            // Re-emit state changes
            this.emit('statusChange');
        });
        
        await client.login(token);
        this.bots.push(botInfo);
        
        return botInfo;
    }
    
    async removeBot(botIndex) {
        const bot = this.bots[botIndex];
        if (!bot) {
            throw new Error('Bot not found');
        }
        
        // Disconnect from all channels
        for (const [guildId, connection] of bot.connections) {
            this.removePlayerFromBroadcast(bot.id, guildId);
            try {
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (e) {}
        }
        bot.connections.clear();
        bot.players.clear();
        
        // Destroy the client
        try {
            await bot.client.destroy();
        } catch (e) {
            console.error(`[Bot] Error destroying client:`, e.message);
        }
        
        // Remove from list and update presets
        const removedUsername = bot.username;
        this.bots.splice(botIndex, 1);
        
        // Reindex preset channels
        const newPresets = new Map();
        for (const [key, channelId] of this.presetChannels) {
            const [bi, guildId] = key.split('-');
            const idx = parseInt(bi);
            if (idx === botIndex) continue; // Remove presets of the removed bot
            const newIdx = idx > botIndex ? idx - 1 : idx;
            newPresets.set(`${newIdx}-${guildId}`, channelId);
        }
        this.presetChannels = newPresets;
        
        console.log(`[Bot] ${removedUsername || 'Bot ' + botIndex} removed`);
        this.emit('statusChange');
        return true;
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
                    guildName: guild?.name || 'Unknown',
                    channelId: conn.joinConfig?.channelId,
                    channelName: channel?.name || 'Unknown',
                    status: conn.state?.status || 'unknown'
                };
            })
        }));
    }
    
    getGuilds(botIndex = null) {
        const guildsMap = new Map();
        
        // If botIndex is specified, use only that bot
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
            throw new Error('Bot is not available');
        }
        
        const guild = bot.client.guilds.cache.get(guildId);
        if (!guild) {
            throw new Error('Server not found');
        }
        
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            throw new Error('Channel not found');
        }
        
        // Disconnect from previous channel if exists (with state check)
        if (bot.connections.has(guildId)) {
            const oldConn = bot.connections.get(guildId);
            try {
                if (oldConn.state.status !== VoiceConnectionStatus.Destroyed) {
                    oldConn.destroy();
                }
            } catch (e) {
                // Ignore error if already destroyed
            }
            bot.connections.delete(guildId);
            bot.players.delete(guildId);
        }
        
        // Use a unique group per bot to avoid conflicts between bots
        const groupId = `bot-${bot.id}`;
        
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
            group: groupId  // Grupo único para cada bot
        });
        
        // Create player for this connection
        const player = createAudioPlayer();
        connection.subscribe(player);
        
        bot.connections.set(guildId, connection);
        bot.players.set(guildId, player);
        
        // Wait for connection
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            console.log(`[Bot] ${bot.username} joined ${channel.name}`);
        } catch (error) {
            connection.destroy();
            bot.connections.delete(guildId);
            bot.players.delete(guildId);
            throw new Error('Timeout connecting to voice channel');
        }
        
        // Handle disconnection
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
            } catch (error) {
                // Remove from broadcast if it was active
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
        
        // If already broadcasting, add this player to the broadcast
        if (this.isBroadcasting()) {
            console.log(`[Bot] Adding ${bot.username} to ongoing broadcast...`);
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
            // Remove from broadcast first
            this.removePlayerFromBroadcast(bot.id, guildId);
            
            try {
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (e) {
                // Ignore error if already destroyed
            }
            bot.connections.delete(guildId);
            bot.players.delete(guildId);
            console.log(`[Bot] ${bot.username} left server ${guildId}`);
        }
        
        this.emit('statusChange');
    }
    
    // Check if there are bots connected to channels
    hasActiveConnections() {
        for (const bot of this.bots) {
            if (bot.connections.size > 0) {
                return true;
            }
        }
        return false;
    }
    
    // Count active connections
    getActiveConnectionCount() {
        let count = 0;
        for (const bot of this.bots) {
            count += bot.connections.size;
        }
        return count;
    }
    
    // Check if broadcasting
    isBroadcasting() {
        return this.sourceStream !== null && !this.sourceStream.destroyed;
    }
    
    startBroadcast(audioStream) {
        // Check if there are active connections
        if (!this.hasActiveConnections()) {
            console.warn('[Broadcast] No bot is connected to a voice channel!');
            return false;
        }
        
        // Stop previous broadcast if exists
        if (this.isBroadcasting()) {
            this.stopBroadcast();
        }
        
        this.sourceStream = audioStream;
        this._isBroadcasting = true;
        
        // Start VAD assuming speaking (to not miss sound start)
        // VAD will detect silence and stop if there's no sound
        this._isSpeaking = true;
        this._lastSpeakingState = true;
        this._silenceStartTime = null;
        this._lastVadCheck = 0;
        this._consecutiveSilence = 0;
        this._consecutiveSound = 0;
        
        // Sync buffer - accumulates data before sending
        // This helps keep all bots synchronized
        const SYNC_BUFFER_SIZE = 3840; // 40ms a 48kHz stereo 16-bit
        let syncBuffer = Buffer.alloc(0);
        
        // Listener to distribute data to all branches synchronously
        this._dataHandler = (chunk) => {
            if (!this._isBroadcasting) return;
            
            // Accumulate in sync buffer
            syncBuffer = Buffer.concat([syncBuffer, chunk]);
            
            // Send when we have enough data
            while (syncBuffer.length >= SYNC_BUFFER_SIZE) {
                const toSend = syncBuffer.slice(0, SYNC_BUFFER_SIZE);
                syncBuffer = syncBuffer.slice(SYNC_BUFFER_SIZE);
                
                // Voice Activity Detection (VAD)
                const now = Date.now();
                const hasSound = this._detectVoiceActivity(toSend);
                
                // Simple logic: sound = transmit, prolonged silence = stop
                if (hasSound) {
                    // Sound detected - transmit and reset silence timer
                    this._silenceStartTime = null;
                    
                    if (!this._isSpeaking) {
                        this._isSpeaking = true;
                        if (DEBUG_MODE) console.log('[VAD] 🎤 Sound detected - transmitting');
                        this.emit('speakingChange', true);
                    }
                } else {
                    // Silence detected
                    if (this._isSpeaking) {
                        if (!this._silenceStartTime) {
                            this._silenceStartTime = now;
                        } else if (now - this._silenceStartTime > this.vadSilenceTimeout) {
                            // Prolonged silence - stop transmission
                            this._isSpeaking = false;
                            if (DEBUG_MODE) console.log('[VAD] 🔇 Silence detected - pausing');
                            this.emit('speakingChange', false);
                        }
                        // Continue transmitting during silence period (until timeout)
                    }
                }
                
                // Transmit if: VAD disabled OR speaking OR still in silence period (before timeout)
                const shouldTransmit = !this.vadEnabled || this._isSpeaking || 
                    (this._silenceStartTime && (now - this._silenceStartTime <= this.vadSilenceTimeout));
                
                if (shouldTransmit) {
                    // Send to all branches at the same time
                    const branches = Array.from(this.streamBranches.entries());
                    let transmitted = 0;
                    let recreated = 0;
                    
                    for (const [connectionId, branch] of branches) {
                        // If branch was destroyed, recreate
                        if (!branch || branch.destroyed) {
                            // Find the corresponding bot and player
                            const [botId, guildId] = connectionId.split('-');
                            const bot = this.bots.find(b => b.id === botId);
                            if (bot) {
                                const player = bot.players.get(guildId);
                                if (player) {
                                    this._setupBranchForPlayer(bot, guildId, player);
                                    recreated++;
                                    // Try sending to new branch
                                    const newBranch = this.streamBranches.get(connectionId);
                                    if (newBranch && !newBranch.destroyed) {
                                        newBranch.write(toSend);
                                        transmitted++;
                                    }
                                }
                            }
                        } else {
                            // Check if internal buffer is not full
                            if (branch.writableLength < branch.writableHighWaterMark * 2) {
                                branch.write(toSend);
                                transmitted++;
                            } else {
                                console.warn('[Broadcast] Buffer full, discarding data to avoid delay');
                            }
                        }
                    }
                    
                    // Debug log (only once per second)
                    if (DEBUG_MODE && (!this._lastTransmitLog || now - this._lastTransmitLog > 1000)) {
                        if (recreated > 0) {
                            console.log(`[VAD Debug] Transmitting to ${transmitted} branches (${recreated} recreated)`);
                        } else {
                            console.log(`[VAD Debug] Transmitting to ${transmitted} branches`);
                        }
                        this._lastTransmitLog = now;
                    }
                }
                // When silent, simply don't send anything
                // Branches can be destroyed but will be recreated when sound returns
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
            console.error('[Broadcast] Audio stream error:', err.message);
            this._isBroadcasting = false;
        });
        
        // Create branches for all active connections
        this._setupAllBranches();
        
        console.log(`[Broadcast] Started for ${this.getActiveConnectionCount()} connection(s)`);
        return true;
    }
    
    // Setup branches for all active players
    _setupAllBranches() {
        for (const bot of this.bots) {
            for (const [guildId, player] of bot.players) {
                this._setupBranchForPlayer(bot, guildId, player);
            }
        }
    }
    
    // Setup individual branch for a player
    _setupBranchForPlayer(bot, guildId, player) {
        const connectionId = `${bot.id}-${guildId}`;
        
        // Remove previous branch if exists
        if (this.streamBranches.has(connectionId)) {
            const oldBranch = this.streamBranches.get(connectionId);
            if (!oldBranch.destroyed) {
                oldBranch.end();
            }
        }
        
        try {
            // Larger buffer for stability (prevents cuts)
            const branch = new PassThrough({
                highWaterMark: 19200  // 200ms buffer a 48kHz stereo 16-bit
            });
            this.streamBranches.set(connectionId, branch);
            
            const resource = createAudioResource(branch, {
                inputType: StreamType.Raw,
                inlineVolume: false
            });
            
            player.play(resource);
            if (DEBUG_MODE) console.log(`[Bot] ${bot.username} broadcasting to ${guildId}`);
            return true;
        } catch (error) {
            console.error(`[Bot] Error setting up broadcast:`, error);
            return false;
        }
    }
    
    // Add a new player to the ongoing broadcast
    addPlayerToBroadcast(bot, guildId, player) {
        if (!this.isBroadcasting()) {
            return false;
        }
        
        return this._setupBranchForPlayer(bot, guildId, player);
    }
    
    // Remove a player from the broadcast
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
        
        // Remove listener from source stream
        if (this.sourceStream && this._dataHandler) {
            this.sourceStream.removeListener('data', this._dataHandler);
        }
        this._dataHandler = null;
        
        // Close all branches
        for (const branch of this.streamBranches.values()) {
            if (!branch.destroyed) {
                branch.end();
            }
        }
        this.streamBranches.clear();
        this.sourceStream = null;
        
        // Stop all players
        for (const bot of this.bots) {
            for (const [guildId, player] of bot.players) {
                try {
                    player.stop();
                } catch (e) {
                    // Ignore errors when stopping
                }
            }
        }
        
        console.log('[Broadcast] Broadcast stopped');
    }
    
    // Detect voice activity (Voice Activity Detection)
    _detectVoiceActivity(audioBuffer) {
        // Audio is PCM 16-bit signed little-endian stereo
        // Calculate RMS (Root Mean Square) of audio
        let sumSquares = 0;
        const samples = audioBuffer.length / 2; // 2 bytes per sample (16-bit)
        
        for (let i = 0; i < audioBuffer.length; i += 2) {
            // Read sample as signed 16-bit little-endian
            const sample = audioBuffer.readInt16LE(i);
            sumSquares += sample * sample;
        }
        
        const rms = Math.sqrt(sumSquares / samples);
        
        // Compare with threshold
        return rms > this.vadThreshold;
    }
    
    // Set VAD threshold
    setVadThreshold(threshold) {
        this.vadThreshold = Math.max(0, Math.min(32767, threshold));
        console.log(`[VAD] Threshold set to: ${this.vadThreshold}`);
    }
    
    // Enable/disable VAD
    setVadEnabled(enabled) {
        this.vadEnabled = enabled;
        console.log(`[VAD] ${enabled ? 'Enabled' : 'Disabled'}`);
    }
    
    // Get VAD status
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
            // Disconnect from all channels
            for (const connection of bot.connections.values()) {
                try {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        connection.destroy();
                    }
                } catch (e) {
                    // Ignore error if already destroyed
                }
            }
            bot.connections.clear();
            bot.players.clear();
            // Destroy the client
            await bot.client.destroy();
        }
        this.bots = [];
    }
}

module.exports = BotManager;
