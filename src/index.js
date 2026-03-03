// Suppress Discord.js deprecation warning ('ready' event)
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('ready event has been renamed')) {
        return; // Ignore this specific warning
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

// Apply saved settings
function applyLoadedConfig() {
    // Apply default audio device
    const savedDeviceId = configManager.getAudioDevice();
    if (savedDeviceId !== null) {
        const devices = audioManager.getAudioDevices();
        const device = devices.find(d => d.id === savedDeviceId);
        if (device) {
            audioManager.setDevice(savedDeviceId);
            console.log(`[Config] Audio device restored: ${device.displayName}`);
        }
    }
    
    // Apply VAD settings
    const vadSettings = configManager.getVadSettings();
    botManager.vadEnabled = vadSettings.enabled;
    botManager.vadThreshold = vadSettings.threshold;
    botManager.vadSilenceTimeout = vadSettings.silenceTimeout;
    console.log(`[Config] VAD restored: enabled=${vadSettings.enabled}, threshold=${vadSettings.threshold}, timeout=${vadSettings.silenceTimeout}ms`);
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global state
let connectedClients = new Set();

// WebSocket for real-time updates
wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    connectedClients.add(ws);
    
    // Send initial state
    sendStateToClient(ws);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            await handleWebSocketMessage(ws, message);
        } catch (error) {
            console.error('[WebSocket] Error processing message:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    });
    
    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
        connectedClients.delete(ws);
    });
});

// WebSocket message handlers
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
            
            // If broadcasting, stop first
            if (wasTransmitting) {
                console.log('[System] Restarting broadcast with new device...');
                stopBroadcast();
            }
            
            audioManager.setDevice(message.deviceId);
            
            // Restart broadcast if it was active
            if (wasTransmitting) {
                setTimeout(() => {
                    startBroadcast();
                    broadcastState();
                }, 500); // Small delay to ensure device is ready
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
            // Save to BotManager and ConfigManager
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
            ws.send(JSON.stringify({ type: 'success', message: 'deviceSavedAsDefault' }));
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
            
        case 'addToken':
            try {
                const newToken = (message.token || '').trim();
                if (!newToken) {
                    ws.send(JSON.stringify({ type: 'error', message: 'tokenCannotBeEmpty' }));
                    break;
                }
                
                // Try starting the bot first to validate the token
                console.log('[System] Adding new bot...');
                await botManager.addBot(newToken);
                
                // If we got here, the token is valid - save to config
                configManager.addToken(newToken);
                
                // Wait a moment for the bot to become ready
                setTimeout(() => broadcastState(), 2000);
                
                ws.send(JSON.stringify({ type: 'success', message: 'botAddedSuccessfully' }));
                broadcastState();
            } catch (error) {
                console.error('[System] Error adding bot:', error.message);
                ws.send(JSON.stringify({ type: 'error', message: `errorAddingBot:${error.message}` }));
            }
            break;
            
        case 'removeToken':
            try {
                const removeIndex = message.botIndex;
                if (removeIndex === undefined || removeIndex < 0 || removeIndex >= botManager.bots.length) {
                    ws.send(JSON.stringify({ type: 'error', message: 'invalidBotIndex' }));
                    break;
                }
                
                // If broadcasting and this is the last connected bot, stop broadcast
                if (isBroadcastActive && botManager.bots.length === 1) {
                    stopBroadcast();
                }
                
                const removedName = botManager.bots[removeIndex]?.username || 'Bot';
                await botManager.removeBot(removeIndex);
                configManager.removeToken(removeIndex);
                
                ws.send(JSON.stringify({ type: 'success', message: `botRemovedSuccessfully:${removedName}` }));
                broadcastState();
            } catch (error) {
                console.error('[System] Error removing bot:', error.message);
                ws.send(JSON.stringify({ type: 'error', message: `errorRemovingBot:${error.message}` }));
            }
            break;
            
        case 'getTokens':
            // Send masked tokens (for security)
            const maskedTokens = configManager.getTokens().map((t, i) => ({
                index: i,
                masked: t.substring(0, 6) + '...' + t.substring(t.length - 4),
                botName: botManager.bots[i]?.username || 'Loading...'
            }));
            ws.send(JSON.stringify({ type: 'tokens', tokens: maskedTokens }));
            break;
    }
}

// Join all preset channels (using ConfigManager)
async function joinAllPresets() {
    const presets = configManager.getChannelPresets();
    const results = [];
    
    for (const preset of presets) {
        try {
            await botManager.joinChannel(preset.botIndex, preset.guildId, preset.channelId);
            results.push({ success: true, ...preset });
        } catch (error) {
            console.error(`[System] Error joining preset channel:`, error.message);
            results.push({ success: false, error: error.message, ...preset });
        }
    }
    
    return results;
}

// Broadcast functions
let isBroadcastActive = false;

function startBroadcast() {
    // Check if there are connected bots
    if (!botManager.hasActiveConnections()) {
        console.warn('[System] Cannot start broadcast - no bot is in a voice channel!');
        broadcastMessage({ type: 'warning', message: 'noBotConnectedToVoiceChannel' });
        return false;
    }
    
    const audioStream = audioManager.startCapture();
    if (audioStream) {
        const success = botManager.startBroadcast(audioStream);
        if (success) {
            isBroadcastActive = true;
            console.log('[System] Broadcast started');
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
    console.log('[System] Broadcast stopped');
}

// Test tone function
function startTestTone() {
    // Check if there are connected bots
    if (!botManager.hasActiveConnections()) {
        console.warn('[System] Cannot start test tone - no bot is in a voice channel!');
        broadcastMessage({ type: 'warning', message: 'noBotConnectedToVoiceChannel' });
        return false;
    }
    
    const audioStream = audioManager.generateTestTone(10000); // 10 seconds
    if (audioStream) {
        const success = botManager.startBroadcast(audioStream);
        if (success) {
            isBroadcastActive = true;
            console.log('[System] Test tone started (10 seconds)');
            return true;
        }
    }
    return false;
}

// Send message to all clients
function broadcastMessage(message) {
    const msgJson = JSON.stringify(message);
    connectedClients.forEach(client => {
        if (client.readyState === 1) {
            client.send(msgJson);
        }
    });
}

// Helper functions
function getStatePayload() {
    // Masked tokens for security
    const maskedTokens = configManager.getTokens().map((t, i) => ({
        index: i,
        masked: t.substring(0, 6) + '...' + t.substring(t.length - 4),
        botName: botManager.bots[i]?.username || 'Loading...'
    }));
    
    return {
        type: 'state',
        bots: botManager.getBotsStatus(),
        audioDevice: audioManager.getCurrentDevice(),
        isBroadcasting: audioManager.isCapturing() || botManager.isBroadcasting(),
        audioDevices: audioManager.getAudioDevices(),
        presetChannels: configManager.getChannelPresets(),
        activeConnections: botManager.getActiveConnectionCount(),
        defaultAudioDevice: configManager.getAudioDevice(),
        vad: botManager.getVadStatus(),
        tokens: maskedTokens
    };
}

function sendStateToClient(ws) {
    ws.send(JSON.stringify(getStatePayload()));
}

function broadcastState() {
    const state = getStatePayload();
    const stateJson = JSON.stringify(state);
    connectedClients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(stateJson);
        }
    });
}

// Manager events
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

// Initialization
async function init() {
    const PORT = process.env.PORT || 3000;
    
    // Load saved settings
    console.log('[Config] Loading settings...');
    
    // Load tokens: first from config, then from .env as fallback
    let tokens = configManager.getTokens();
    
    if (tokens.length === 0) {
        // Fallback: load from .env if no tokens in config
        const envTokens = (process.env.BOT_TOKENS || '').split(',').filter(t => t.trim());
        if (envTokens.length > 0) {
            console.log('[Config] Migrating tokens from .env to config.json...');
            for (const t of envTokens) {
                configManager.addToken(t.trim());
            }
            tokens = envTokens.map(t => t.trim());
        }
    }
    
    if (tokens.length === 0) {
        console.warn('[WARNING] No bot tokens configured!');
        console.warn('Add tokens via web interface or set BOT_TOKENS in .env');
        console.log('[System] Starting without bots \u2014 add tokens via web interface.');
    } else {
        console.log(`[System] Starting ${tokens.length} bot(s)...`);
        
        for (const token of tokens) {
            try {
                await botManager.addBot(token.trim());
            } catch (error) {
                console.error(`[ERROR] Failed to start bot:`, error.message);
            }
        }
    }
    
    // Apply settings after bots are ready
    setTimeout(() => {
        applyLoadedConfig();
        
        // Restore preset channels to BotManager
        const presets = configManager.getChannelPresets();
        for (const preset of presets) {
            botManager.setPresetChannel(preset.botIndex, preset.guildId, preset.channelId);
        }
        console.log(`[Config] ${presets.length} preset channel(s) restored`);
    }, 2000);
    
    // Start server
    server.listen(PORT, () => {
        console.log(`[System] Server running at http://localhost:${PORT}`);
        console.log('[System] Open browser to access the management interface');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down...');
    stopBroadcast();
    await botManager.shutdown();
    process.exit(0);
});

init().catch(console.error);
