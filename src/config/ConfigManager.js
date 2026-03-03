const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.json');

class ConfigManager extends EventEmitter {
    constructor() {
        super();
        this.config = {
            tokens: [],                  // Array of bot tokens
            audioDevice: null,           // Default audio device ID
            channelPresets: [],          // Array of { botIndex, guildId, channelId }
            lastUsedDevice: null,        // Last used device
            volume: 100,                 // Volume (for future use)
            autoStartBroadcast: false,   // Auto-start broadcast on connect
            // VAD settings
            vadEnabled: true,            // Enable/disable VAD
            vadThreshold: 50,            // Low threshold for absolute silence
            vadSilenceTimeout: 500,      // ms of silence before stopping
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        this.load();
    }
    
    // Load settings from file
    load() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = fs.readFileSync(CONFIG_FILE, 'utf8');
                const loaded = JSON.parse(data);
                this.config = { ...this.config, ...loaded };
                console.log('[Config] Settings loaded from', CONFIG_FILE);
                return true;
            } else {
                console.log('[Config] Config file not found, using defaults');
                this.save(); // Create file with defaults
                return false;
            }
        } catch (error) {
            console.error('[Config] Error loading settings:', error.message);
            return false;
        }
    }
    
    // Save settings to file
    save() {
        try {
            this.config.updatedAt = new Date().toISOString();
            const data = JSON.stringify(this.config, null, 2);
            fs.writeFileSync(CONFIG_FILE, data, 'utf8');
            console.log('[Config] Settings saved');
            this.emit('saved');
            return true;
        } catch (error) {
            console.error('[Config] Error saving settings:', error.message);
            return false;
        }
    }
    
    // Get default audio device
    getAudioDevice() {
        return this.config.audioDevice;
    }
    
    // Set default audio device
    setAudioDevice(deviceId) {
        this.config.audioDevice = deviceId;
        this.config.lastUsedDevice = deviceId;
        this.save();
        this.emit('audioDeviceChanged', deviceId);
    }
    
    // Get channel presets
    getChannelPresets() {
        return this.config.channelPresets || [];
    }
    
    // Add channel preset
    addChannelPreset(botIndex, guildId, channelId, guildName, channelName, botName) {
        // Remove existing preset for the same bot/server
        this.config.channelPresets = this.config.channelPresets.filter(
            p => !(p.botIndex === botIndex && p.guildId === guildId)
        );
        
        // Add new preset
        this.config.channelPresets.push({
            botIndex,
            guildId,
            channelId,
            guildName: guildName || 'Unknown',
            channelName: channelName || 'Unknown',
            botName: botName || `Bot ${botIndex}`,
            createdAt: new Date().toISOString()
        });
        
        this.save();
        this.emit('presetAdded', { botIndex, guildId, channelId });
    }
    
    // Remove channel preset
    removeChannelPreset(botIndex, guildId) {
        const before = this.config.channelPresets.length;
        this.config.channelPresets = this.config.channelPresets.filter(
            p => !(p.botIndex === botIndex && p.guildId === guildId)
        );
        
        if (this.config.channelPresets.length !== before) {
            this.save();
            this.emit('presetRemoved', { botIndex, guildId });
        }
    }
    
    // Clear all channel presets
    clearChannelPresets() {
        this.config.channelPresets = [];
        this.save();
        this.emit('presetsCleared');
    }
    
    // Get full configuration
    getAll() {
        return { ...this.config };
    }
    
    // VAD settings
    getVadSettings() {
        return {
            enabled: this.config.vadEnabled !== false,
            threshold: this.config.vadThreshold || 50,
            silenceTimeout: this.config.vadSilenceTimeout || 500
        };
    }
    
    setVadEnabled(enabled) {
        this.config.vadEnabled = enabled;
        this.save();
        this.emit('vadChanged', this.getVadSettings());
    }
    
    setVadThreshold(threshold) {
        this.config.vadThreshold = threshold;
        this.save();
        this.emit('vadChanged', this.getVadSettings());
    }
    
    setVadSilenceTimeout(timeout) {
        this.config.vadSilenceTimeout = timeout;
        this.save();
        this.emit('vadChanged', this.getVadSettings());
    }
    
    // === Token Management ===
    
    // Get all tokens
    getTokens() {
        return this.config.tokens || [];
    }
    
    // Add a token
    addToken(token) {
        if (!this.config.tokens) {
            this.config.tokens = [];
        }
        // Check if already exists
        if (this.config.tokens.includes(token)) {
            return false;
        }
        this.config.tokens.push(token);
        this.save();
        this.emit('tokenAdded', token);
        return true;
    }
    
    // Remove a token by index
    removeToken(index) {
        if (!this.config.tokens || index < 0 || index >= this.config.tokens.length) {
            return false;
        }
        const removed = this.config.tokens.splice(index, 1)[0];
        
        // Update channelPresets: remove presets of the removed bot and reindex
        if (this.config.channelPresets) {
            this.config.channelPresets = this.config.channelPresets
                .filter(p => p.botIndex !== index)
                .map(p => ({
                    ...p,
                    botIndex: p.botIndex > index ? p.botIndex - 1 : p.botIndex
                }));
        }
        
        this.save();
        this.emit('tokenRemoved', { index, token: removed });
        return true;
    }
    
    // Set configuration
    set(key, value) {
        this.config[key] = value;
        this.save();
        this.emit('configChanged', { key, value });
    }
    
    // Get configuration
    get(key) {
        return this.config[key];
    }
}

module.exports = ConfigManager;
