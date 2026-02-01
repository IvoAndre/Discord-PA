// Suprimir aviso de deprecação do Discord.js (evento 'ready')
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('ready event has been renamed')) {
        return; // Ignorar este aviso específico
    }
    originalEmitWarning.call(process, warning, ...args);
};

require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const BotManager = require('./bot/BotManager');
const AudioManager = require('./audio/AudioManager');
const ConfigManager = require('./config/ConfigManager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Managers
const configManager = new ConfigManager();
const botManager = new BotManager();
const audioManager = new AudioManager();

// Aplicar configurações guardadas
function applyLoadedConfig() {
    // Aplicar dispositivo de áudio predefinido
    const savedDeviceId = configManager.getAudioDevice();
    if (savedDeviceId !== null) {
        const devices = audioManager.getAudioDevices();
        const device = devices.find(d => d.id === savedDeviceId);
        if (device) {
            audioManager.setDevice(savedDeviceId);
            console.log(`[Config] Dispositivo de áudio restaurado: ${device.displayName}`);
        }
    }
    
    // Aplicar configurações VAD
    const vadSettings = configManager.getVadSettings();
    botManager.vadEnabled = vadSettings.enabled;
    botManager.vadThreshold = vadSettings.threshold;
    botManager.vadSilenceTimeout = vadSettings.silenceTimeout;
    console.log(`[Config] VAD restaurado: enabled=${vadSettings.enabled}, threshold=${vadSettings.threshold}, timeout=${vadSettings.silenceTimeout}ms`);
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado global
let connectedClients = new Set();

// WebSocket para atualizações em tempo real
wss.on('connection', (ws) => {
    console.log('[WebSocket] Cliente conectado');
    connectedClients.add(ws);
    
    // Enviar estado inicial
    sendStateToClient(ws);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            await handleWebSocketMessage(ws, message);
        } catch (error) {
            console.error('[WebSocket] Erro ao processar mensagem:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    });
    
    ws.on('close', () => {
        console.log('[WebSocket] Cliente desconectado');
        connectedClients.delete(ws);
    });
});

// Handlers de mensagens WebSocket
async function handleWebSocketMessage(ws, message) {
    switch (message.type) {
        case 'getState':
            sendStateToClient(ws);
            break;
            
        case 'getAudioDevices':
            const devices = audioManager.getAudioDevices();
            ws.send(JSON.stringify({ type: 'audioDevices', devices }));
            break;
            
        case 'refreshAudioDevices':
            const refreshedDevices = audioManager.refreshDevices();
            ws.send(JSON.stringify({ type: 'audioDevices', devices: refreshedDevices }));
            broadcastState();
            break;
            
        case 'setAudioDevice':
            const wasTransmitting = isBroadcastActive;
            
            // Se estiver a transmitir, parar primeiro
            if (wasTransmitting) {
                console.log('[Sistema] A reiniciar transmissão com novo dispositivo...');
                stopBroadcast();
            }
            
            audioManager.setDevice(message.deviceId);
            
            // Reiniciar transmissão se estava ativa
            if (wasTransmitting) {
                setTimeout(() => {
                    startBroadcast();
                    broadcastState();
                }, 500); // Pequeno delay para garantir que o dispositivo está pronto
            }
            
            broadcastState();
            break;
            
        case 'joinChannel':
            await botManager.joinChannel(message.botIndex, message.guildId, message.channelId);
            broadcastState();
            break;
            
        case 'leaveChannel':
            await botManager.leaveChannel(message.botIndex, message.guildId);
            broadcastState();
            break;
            
        case 'startBroadcast':
            startBroadcast();
            broadcastState();
            break;
            
        case 'startTestTone':
            startTestTone();
            broadcastState();
            break;
            
        case 'stopBroadcast':
            stopBroadcast();
            broadcastState();
            break;
            
        case 'getGuilds':
            const selectedBotIndex = message.botIndex;
            const guilds = botManager.getGuilds(selectedBotIndex);
            ws.send(JSON.stringify({ type: 'guilds', guilds }));
            break;
            
        case 'getChannels':
            const channels = botManager.getVoiceChannels(message.guildId);
            ws.send(JSON.stringify({ type: 'channels', guildId: message.guildId, channels }));
            break;
            
        case 'setPresetChannel':
            // Guardar no BotManager e no ConfigManager
            const bot = botManager.bots[message.botIndex];
            const guild = bot?.client.guilds.cache.get(message.guildId);
            const channel = guild?.channels.cache.get(message.channelId);
            
            botManager.setPresetChannel(message.botIndex, message.guildId, message.channelId);
            configManager.addChannelPreset(
                message.botIndex,
                message.guildId,
                message.channelId,
                guild?.name,
                channel?.name,
                bot?.username
            );
            broadcastState();
            break;
            
        case 'removePresetChannel':
            botManager.setPresetChannel(message.botIndex, message.guildId, null);
            configManager.removeChannelPreset(message.botIndex, message.guildId);
            broadcastState();
            break;
            
        case 'getPresetChannels':
            const presets = configManager.getChannelPresets();
            ws.send(JSON.stringify({ type: 'presetChannels', presets }));
            break;
            
        case 'setDefaultAudioDevice':
            audioManager.setDevice(message.deviceId);
            configManager.setAudioDevice(message.deviceId);
            broadcastState();
            ws.send(JSON.stringify({ type: 'success', message: 'Dispositivo guardado como predefinido' }));
            break;
            
        case 'joinAllPresets':
            const results = await joinAllPresets();
            ws.send(JSON.stringify({ type: 'joinAllPresetsResult', results }));
            broadcastState();
            break;
            
        case 'leaveAllChannels':
            await botManager.leaveAllChannels();
            broadcastState();
            break;
            
        case 'getConfig':
            ws.send(JSON.stringify({ type: 'config', config: configManager.getAll() }));
            break;
            
        case 'setVadEnabled':
            botManager.vadEnabled = message.enabled;
            configManager.setVadEnabled(message.enabled);
            broadcastState();
            break;
            
        case 'setVadThreshold':
            botManager.vadThreshold = message.threshold;
            configManager.setVadThreshold(message.threshold);
            broadcastState();
            break;
            
        case 'setVadSilenceTimeout':
            botManager.vadSilenceTimeout = message.timeout;
            configManager.setVadSilenceTimeout(message.timeout);
            broadcastState();
            break;
            
        case 'getVadStatus':
            ws.send(JSON.stringify({ type: 'vadStatus', status: botManager.getVadStatus() }));
            break;
    }
}

// Entrar em todos os canais predefinidos (usando ConfigManager)
async function joinAllPresets() {
    const presets = configManager.getChannelPresets();
    const results = [];
    
    for (const preset of presets) {
        try {
            await botManager.joinChannel(preset.botIndex, preset.guildId, preset.channelId);
            results.push({ success: true, ...preset });
        } catch (error) {
            console.error(`[Sistema] Erro ao entrar no canal predefinido:`, error.message);
            results.push({ success: false, error: error.message, ...preset });
        }
    }
    
    return results;
}

// Funções de broadcast
let isBroadcastActive = false;

function startBroadcast() {
    // Verificar se há bots conectados
    if (!botManager.hasActiveConnections()) {
        console.warn('[Sistema] Não é possível iniciar transmissão - nenhum bot está num canal de voz!');
        broadcastMessage({ type: 'warning', message: 'Nenhum bot está conectado a um canal de voz!' });
        return false;
    }
    
    const audioStream = audioManager.startCapture();
    if (audioStream) {
        const success = botManager.startBroadcast(audioStream);
        if (success) {
            isBroadcastActive = true;
            console.log('[Sistema] Transmissão iniciada');
            return true;
        } else {
            audioManager.stopCapture();
            return false;
        }
    }
    return false;
}

function stopBroadcast() {
    isBroadcastActive = false;
    audioManager.stopCapture();
    botManager.stopBroadcast();
    console.log('[Sistema] Transmissão parada');
}

// Função para tom de teste
function startTestTone() {
    // Verificar se há bots conectados
    if (!botManager.hasActiveConnections()) {
        console.warn('[Sistema] Não é possível iniciar tom de teste - nenhum bot está num canal de voz!');
        broadcastMessage({ type: 'warning', message: 'Nenhum bot está conectado a um canal de voz!' });
        return false;
    }
    
    const audioStream = audioManager.generateTestTone(10000); // 10 segundos
    if (audioStream) {
        const success = botManager.startBroadcast(audioStream);
        if (success) {
            isBroadcastActive = true;
            console.log('[Sistema] Tom de teste iniciado (10 segundos)');
            return true;
        }
    }
    return false;
}

// Enviar mensagem para todos os clientes
function broadcastMessage(message) {
    const msgJson = JSON.stringify(message);
    connectedClients.forEach(client => {
        if (client.readyState === 1) {
            client.send(msgJson);
        }
    });
}

// Funções auxiliares
function sendStateToClient(ws) {
    const state = {
        type: 'state',
        bots: botManager.getBotsStatus(),
        audioDevice: audioManager.getCurrentDevice(),
        isBroadcasting: audioManager.isCapturing() || botManager.isBroadcasting(),
        audioDevices: audioManager.getAudioDevices(),
        presetChannels: configManager.getChannelPresets(),
        activeConnections: botManager.getActiveConnectionCount(),
        defaultAudioDevice: configManager.getAudioDevice(),
        vad: botManager.getVadStatus()
    };
    ws.send(JSON.stringify(state));
}

function broadcastState() {
    const state = {
        type: 'state',
        bots: botManager.getBotsStatus(),
        audioDevice: audioManager.getCurrentDevice(),
        isBroadcasting: audioManager.isCapturing() || botManager.isBroadcasting(),
        audioDevices: audioManager.getAudioDevices(),
        presetChannels: configManager.getChannelPresets(),
        activeConnections: botManager.getActiveConnectionCount(),
        defaultAudioDevice: configManager.getAudioDevice(),
        vad: botManager.getVadStatus()
    };
    const stateJson = JSON.stringify(state);
    connectedClients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(stateJson);
        }
    });
}

// Eventos dos managers
botManager.on('statusChange', () => broadcastState());
audioManager.on('statusChange', () => broadcastState());

// API REST (fallback)
app.get('/api/state', (req, res) => {
    res.json({
        bots: botManager.getBotsStatus(),
        audioDevice: audioManager.getCurrentDevice(),
        isBroadcasting: audioManager.isCapturing()
    });
});

app.get('/api/audio-devices', (req, res) => {
    res.json(audioManager.getAudioDevices());
});

// Inicialização
async function init() {
    const PORT = process.env.PORT || 3000;
    
    // Carregar configurações guardadas
    console.log('[Config] A carregar configurações...');
    
    // Iniciar bots
    const tokens = (process.env.BOT_TOKENS || '').split(',').filter(t => t.trim());
    
    if (tokens.length === 0) {
        console.warn('[AVISO] Nenhum token de bot configurado!');
        console.warn('Configure a variável BOT_TOKENS no ficheiro .env');
        console.warn('Exemplo: BOT_TOKENS=token1,token2');
        console.log('[Sistema] A iniciar em modo de demonstração...');
    } else {
        console.log(`[Sistema] A iniciar ${tokens.length} bot(s)...`);
        
        for (const token of tokens) {
            try {
                await botManager.addBot(token.trim());
            } catch (error) {
                console.error(`[ERRO] Falha ao iniciar bot:`, error.message);
            }
        }
    }
    
    // Aplicar configurações após os bots estarem prontos
    setTimeout(() => {
        applyLoadedConfig();
        
        // Restaurar canais predefinidos para o BotManager
        const presets = configManager.getChannelPresets();
        for (const preset of presets) {
            botManager.setPresetChannel(preset.botIndex, preset.guildId, preset.channelId);
        }
        console.log(`[Config] ${presets.length} canal(is) predefinido(s) restaurado(s)`);
    }, 2000);
    
    // Iniciar servidor
    server.listen(PORT, () => {
        console.log(`[Sistema] Servidor a correr em http://localhost:${PORT}`);
        console.log('[Sistema] Abra o navegador para aceder à interface de gestão');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Sistema] A encerrar...');
    stopBroadcast();
    await botManager.shutdown();
    process.exit(0);
});

init().catch(console.error);
