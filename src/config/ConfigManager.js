const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.json');

class ConfigManager extends EventEmitter {
    constructor() {
        super();
        this.config = {
            audioDevice: null,           // ID do dispositivo de áudio predefinido
            channelPresets: [],          // Array de { botIndex, guildId, channelId }
            lastUsedDevice: null,        // Último dispositivo usado
            volume: 100,                 // Volume (para futuro uso)
            autoStartBroadcast: false,   // Auto-iniciar transmissão ao conectar
            // VAD settings
            vadEnabled: true,            // Ativar/desativar VAD
            vadThreshold: 50,            // Threshold baixo para silêncio absoluto
            vadSilenceTimeout: 500,      // ms de silêncio antes de parar
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        this.load();
    }
    
    // Carregar configurações do ficheiro
    load() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = fs.readFileSync(CONFIG_FILE, 'utf8');
                const loaded = JSON.parse(data);
                this.config = { ...this.config, ...loaded };
                console.log('[Config] Configurações carregadas de', CONFIG_FILE);
                return true;
            } else {
                console.log('[Config] Ficheiro de configuração não encontrado, a usar predefinições');
                this.save(); // Criar ficheiro com predefinições
                return false;
            }
        } catch (error) {
            console.error('[Config] Erro ao carregar configurações:', error.message);
            return false;
        }
    }
    
    // Guardar configurações no ficheiro
    save() {
        try {
            this.config.updatedAt = new Date().toISOString();
            const data = JSON.stringify(this.config, null, 2);
            fs.writeFileSync(CONFIG_FILE, data, 'utf8');
            console.log('[Config] Configurações guardadas');
            this.emit('saved');
            return true;
        } catch (error) {
            console.error('[Config] Erro ao guardar configurações:', error.message);
            return false;
        }
    }
    
    // Obter dispositivo de áudio predefinido
    getAudioDevice() {
        return this.config.audioDevice;
    }
    
    // Definir dispositivo de áudio predefinido
    setAudioDevice(deviceId) {
        this.config.audioDevice = deviceId;
        this.config.lastUsedDevice = deviceId;
        this.save();
        this.emit('audioDeviceChanged', deviceId);
    }
    
    // Obter predefinições de canais
    getChannelPresets() {
        return this.config.channelPresets || [];
    }
    
    // Adicionar predefinição de canal
    addChannelPreset(botIndex, guildId, channelId, guildName, channelName, botName) {
        // Remover predefinição existente para o mesmo bot/servidor
        this.config.channelPresets = this.config.channelPresets.filter(
            p => !(p.botIndex === botIndex && p.guildId === guildId)
        );
        
        // Adicionar nova predefinição
        this.config.channelPresets.push({
            botIndex,
            guildId,
            channelId,
            guildName: guildName || 'Desconhecido',
            channelName: channelName || 'Desconhecido',
            botName: botName || `Bot ${botIndex}`,
            createdAt: new Date().toISOString()
        });
        
        this.save();
        this.emit('presetAdded', { botIndex, guildId, channelId });
    }
    
    // Remover predefinição de canal
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
    
    // Limpar todas as predefinições de canais
    clearChannelPresets() {
        this.config.channelPresets = [];
        this.save();
        this.emit('presetsCleared');
    }
    
    // Obter configuração completa
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
    
    // Definir configuração
    set(key, value) {
        this.config[key] = value;
        this.save();
        this.emit('configChanged', { key, value });
    }
    
    // Obter configuração
    get(key) {
        return this.config[key];
    }
}

module.exports = ConfigManager;
