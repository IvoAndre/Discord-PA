const EventEmitter = require('events');
const { PassThrough } = require('stream');
const { spawn, execSync } = require('child_process');

let ffmpegPath = null;

// Carregar ffmpeg
try {
    ffmpegPath = require('ffmpeg-static');
    console.log('[Áudio] FFmpeg disponível:', ffmpegPath);
} catch (error) {
    console.warn('[Áudio] ffmpeg-static não encontrado');
    // Tentar usar ffmpeg do sistema
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        ffmpegPath = 'ffmpeg';
        console.log('[Áudio] Usando FFmpeg do sistema');
    } catch (e) {
        console.error('[Áudio] FFmpeg não encontrado!');
    }
}

class AudioManager extends EventEmitter {
    constructor() {
        super();
        this.currentDeviceId = null;
        this.currentDeviceName = null;
        this._isCapturing = false;
        this.audioStream = null;
        this.ffmpegProcess = null;
        this.cachedDevices = null;
    }
    
    // Listar TODOS os dispositivos de áudio do Windows
    getAudioDevices() {
        if (this.cachedDevices) {
            return this.cachedDevices;
        }
        
        const devices = [];
        let deviceIndex = 0;
        const recordingDeviceNames = new Set();
        
        // 1. Listar dispositivos de GRAVAÇÃO (DirectShow via FFmpeg)
        if (ffmpegPath) {
            try {
                const result = execSync(`"${ffmpegPath}" -list_devices true -f dshow -i dummy 2>&1`, {
                    encoding: 'utf8',
                    timeout: 10000,
                    shell: true
                }).toString();
                
                const recordingNames = this._parseAudioDevices(result);
                recordingNames.forEach(name => {
                    recordingDeviceNames.add(name.toLowerCase());
                    devices.push({
                        id: deviceIndex++,
                        name: name,
                        type: 'recording',
                        displayName: `🎤 ${name}`,
                        isRecording: true,
                        isPlayback: false
                    });
                });
            } catch (error) {
                const output = error.stdout || error.stderr || error.message || '';
                const recordingNames = this._parseAudioDevices(output.toString());
                recordingNames.forEach(name => {
                    recordingDeviceNames.add(name.toLowerCase());
                    devices.push({
                        id: deviceIndex++,
                        name: name,
                        type: 'recording',
                        displayName: `🎤 ${name}`,
                        isRecording: true,
                        isPlayback: false
                    });
                });
            }
        }
        
        // 2. Listar TODOS os dispositivos de áudio (AudioEndpoint) via PowerShell
        try {
            // Get-PnpDevice lista todos os endpoints de áudio do Windows
            const psCommand = `powershell -Command "Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object -ExpandProperty FriendlyName"`;
            const allEndpoints = execSync(psCommand, {
                encoding: 'utf8',
                timeout: 15000
            }).toString();
            
            const allDeviceNames = allEndpoints.split('\n')
                .map(d => d.trim())
                .filter(d => d && d.length > 0);
            
            allDeviceNames.forEach(name => {
                // Verificar se já existe como dispositivo de gravação (comparação case-insensitive)
                const isAlreadyRecording = recordingDeviceNames.has(name.toLowerCase());
                
                if (!isAlreadyRecording) {
                    // Determinar se é entrada (Input) ou saída (Output/Playback)
                    const isInput = /Input|Microphone|Mic|Line In|Conjunto de microfones/i.test(name);
                    
                    devices.push({
                        id: deviceIndex++,
                        name: name,
                        type: isInput ? 'recording' : 'playback',
                        displayName: isInput ? `🎤 ${name}` : `🔊 ${name}`,
                        isRecording: isInput,
                        isPlayback: !isInput,
                        requiresLoopback: !isInput
                    });
                }
            });
        } catch (error) {
            console.warn('[Áudio] Não foi possível listar dispositivos via Get-PnpDevice:', error.message);
        }
        
        if (devices.length === 0) {
            devices.push({
                id: 0,
                name: 'Nenhum dispositivo encontrado',
                type: 'none',
                displayName: 'Nenhum dispositivo encontrado',
                isRecording: false,
                isPlayback: false
            });
        }
        
        // Ordenar: Gravação primeiro (mais úteis para captura), depois reprodução
        devices.sort((a, b) => {
            if (a.isRecording && !b.isRecording) return -1;
            if (!a.isRecording && b.isRecording) return 1;
            return a.name.localeCompare(b.name);
        });
        
        // Reindexar após ordenação
        devices.forEach((d, i) => d.id = i);
        
        this.cachedDevices = devices;
        console.log(`[Áudio] ${devices.length} dispositivo(s) encontrado(s):`);
        console.log(`  - Gravação: ${devices.filter(d => d.isRecording).length}`);
        console.log(`  - Reprodução: ${devices.filter(d => d.isPlayback).length}`);
        return devices;
    }
    
    _parseAudioDevices(output) {
        const devices = [];
        const lines = output.split('\n');
        
        for (const line of lines) {
            // Procurar linhas com "(audio)" que indicam dispositivos de áudio
            const match = line.match(/\[dshow[^\]]*\]\s*"([^"]+)"\s*\(audio\)/i);
            if (match) {
                devices.push(match[1]);
            }
        }
        
        return devices;
    }
    
    refreshDevices() {
        this.cachedDevices = null;
        return this.getAudioDevices();
    }
    
    getCurrentDevice() {
        const devices = this.getAudioDevices();
        
        if (this.currentDeviceId !== null) {
            return devices.find(d => d.id === this.currentDeviceId) || devices[0];
        }
        
        return devices.find(d => d.isDefault) || devices[0] || null;
    }
    
    setDevice(deviceId) {
        const devices = this.getAudioDevices();
        const numericId = typeof deviceId === 'string' ? parseInt(deviceId, 10) : deviceId;
        const device = devices.find(d => d.id === numericId);
        
        if (device) {
            this.currentDeviceId = numericId;
            this.currentDeviceName = device.name;
            console.log(`[Áudio] Dispositivo selecionado: ${device.displayName} (ID: ${numericId})`);
        } else {
            console.warn(`[Áudio] Dispositivo com ID ${numericId} não encontrado`);
        }
        
        this.emit('statusChange');
        return device;
    }
    
    startCapture() {
        if (this._isCapturing) {
            console.log('[Áudio] Já está a capturar');
            return this.audioStream;
        }
        
        const device = this.getCurrentDevice();
        if (!device) {
            console.error('[Áudio] Nenhum dispositivo de áudio disponível');
            return null;
        }
        
        if (!ffmpegPath) {
            console.error('[Áudio] FFmpeg não disponível');
            return null;
        }
        
        if (device.type === 'loopback-hint') {
            console.error('[Áudio] Por favor, ative o "Stereo Mix" no Painel de Controlo do Windows');
            console.error('[Áudio] Painel de Controlo > Som > Gravação > Stereo Mix > Ativar');
            return null;
        }
        
        // Criar stream passthrough com buffer para estabilidade
        this.audioStream = new PassThrough({
            highWaterMark: 9600  // 100ms buffer a 48kHz stereo 16-bit para estabilidade
        });
        
        console.log(`[Áudio] A iniciar captura de: ${device.displayName}`);
        
        // Argumentos FFmpeg otimizados para latência mínima
        // Para virtual-audio-capturer, usar configurações especiais
        let args;
        
        if (device.name.toLowerCase().includes('virtual-audio-capturer')) {
            // virtual-audio-capturer pode precisar de configurações específicas
            args = [
                '-f', 'dshow',
                '-audio_buffer_size', '50',          // Buffer maior para estabilidade
                '-i', `audio=${device.name}`,
                '-acodec', 'pcm_s16le',
                '-ar', '48000',
                '-ac', '2',
                '-flush_packets', '1',
                '-fflags', '+nobuffer',
                '-f', 's16le',
                '-'
            ];
        } else {
            // Configuração balanceada - estabilidade vs latência
            args = [
                '-f', 'dshow',
                '-audio_buffer_size', '30',          // Buffer de 30ms para estabilidade
                '-i', `audio=${device.name}`,
                '-acodec', 'pcm_s16le',
                '-ar', '48000',
                '-ac', '2',
                '-flush_packets', '1',               // Enviar pacotes imediatamente
                '-fflags', '+nobuffer+flush_packets',
                '-flags', 'low_delay',               // Modo baixa latência
                '-probesize', '32',                  // Análise mínima
                '-analyzeduration', '0',             // Sem análise de duração
                '-f', 's16le',
                '-'
            ];
        }
        
        console.log(`[Áudio] FFmpeg: ${args.join(' ')}`);
        
        this.ffmpegProcess = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let dataReceived = false;
        let bytesReceived = 0;
        
        // Transmitir dados imediatamente sem buffering adicional
        this.ffmpegProcess.stdout.on('data', (data) => {
            if (!dataReceived) {
                dataReceived = true;
                console.log(`[Áudio] Primeiros dados recebidos do dispositivo`);
            }
            bytesReceived += data.length;
            if (this.audioStream && !this.audioStream.destroyed) {
                this.audioStream.write(data);
            }
        });
        
        // Log periódico de bytes recebidos para diagnóstico (apenas em modo debug)
        if (process.argv.includes('--debug') || process.env.DEBUG === 'true') {
            this._statsInterval = setInterval(() => {
                if (this._isCapturing) {
                    console.log(`[Áudio] Bytes recebidos: ${(bytesReceived / 1024).toFixed(1)} KB`);
                }
            }, 5000);
        }
        
        this.ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            // Mostrar mais informação para diagnóstico
            if (msg.toLowerCase().includes('error')) {
                console.error(`[FFmpeg ERRO] ${msg.trim()}`);
            } else if (msg.includes('Stream') || msg.includes('Audio')) {
                console.log(`[FFmpeg] ${msg.trim()}`);
            }
        });
        
        this.ffmpegProcess.on('error', (error) => {
            console.error('[Áudio] Erro ao iniciar FFmpeg:', error.message);
            this._isCapturing = false;
            this.emit('statusChange');
        });
        
        this.ffmpegProcess.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.log(`[Áudio] FFmpeg terminou com código: ${code}`);
            }
            if (this._isCapturing) {
                this._isCapturing = false;
                this.emit('statusChange');
            }
        });
        
        this._isCapturing = true;
        console.log(`[Áudio] Captura iniciada: ${device.displayName}`);
        this.emit('statusChange');
        
        return this.audioStream;
    }
    
    stopCapture() {
        if (!this._isCapturing) return;
        
        console.log('[Áudio] A parar captura...');
        
        // Parar intervalo de estatísticas
        if (this._statsInterval) {
            clearInterval(this._statsInterval);
            this._statsInterval = null;
        }
        
        // Parar intervalo de tom de teste se existir
        if (this.toneInterval) {
            clearInterval(this.toneInterval);
            this.toneInterval = null;
        }
        
        // Parar processo FFmpeg
        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill('SIGTERM');
            } catch (error) {
                // Ignorar erros ao matar processo
            }
            this.ffmpegProcess = null;
        }
        
        // Fechar stream
        if (this.audioStream) {
            try {
                this.audioStream.end();
            } catch (error) {
                // Ignorar erros
            }
            this.audioStream = null;
        }
        
        this._isCapturing = false;
        console.log('[Áudio] Captura parada');
        this.emit('statusChange');
    }
    
    isCapturing() {
        return this._isCapturing;
    }
    
    // Gerar tom de teste (seno a 440Hz) - para debug
    generateTestTone(durationMs = 5000) {
        console.log('[Áudio] A gerar tom de teste...');
        this.audioStream = new PassThrough({
            highWaterMark: 960
        });
        this._isCapturing = true;
        
        const sampleRate = 48000;
        const channels = 2;
        const frequency = 440; // Hz (nota A4)
        const amplitude = 0.3;
        
        let phase = 0;
        const samplesPerFrame = Math.floor(sampleRate * 0.02); // 20ms frames
        const totalFrames = Math.ceil(durationMs / 20);
        let frameCount = 0;
        
        this.toneInterval = setInterval(() => {
            if (frameCount >= totalFrames) {
                this.stopCapture();
                return;
            }
            
            const buffer = Buffer.alloc(samplesPerFrame * channels * 2);
            
            for (let i = 0; i < samplesPerFrame; i++) {
                const sample = Math.sin(phase) * amplitude * 32767;
                const sampleInt = Math.floor(sample);
                
                // Escrever para ambos os canais (estéreo)
                buffer.writeInt16LE(sampleInt, i * 4);
                buffer.writeInt16LE(sampleInt, i * 4 + 2);
                
                phase += (2 * Math.PI * frequency) / sampleRate;
                if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
            }
            
            if (this.audioStream && !this.audioStream.destroyed) {
                this.audioStream.write(buffer);
            }
            
            frameCount++;
        }, 20);
        
        this.emit('statusChange');
        return this.audioStream;
    }
}

module.exports = AudioManager;
