const EventEmitter = require('events');
const { PassThrough } = require('stream');
const { spawn, execSync } = require('child_process');

let ffmpegPath = null;

// Load ffmpeg
try {
    ffmpegPath = require('ffmpeg-static');
    console.log('[Audio] FFmpeg available:', ffmpegPath);
} catch (error) {
    console.warn('[Audio] ffmpeg-static not found');
    // Try using system ffmpeg
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        ffmpegPath = 'ffmpeg';
        console.log('[Audio] Using system FFmpeg');
    } catch (e) {
        console.error('[Audio] FFmpeg not found!');
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
    
    // List ALL Windows audio devices
    getAudioDevices() {
        if (this.cachedDevices) {
            return this.cachedDevices;
        }
        
        const devices = [];
        let deviceIndex = 0;
        const recordingDeviceNames = new Set();
        
        // 1. List RECORDING devices (DirectShow via FFmpeg)
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
        
        // 2. List ALL audio devices (AudioEndpoint) via PowerShell
        try {
            // Get-PnpDevice lists all Windows audio endpoints
            const psCommand = `powershell -Command "Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object -ExpandProperty FriendlyName"`;
            const allEndpoints = execSync(psCommand, {
                encoding: 'utf8',
                timeout: 15000
            }).toString();
            
            const allDeviceNames = allEndpoints.split('\n')
                .map(d => d.trim())
                .filter(d => d && d.length > 0);
            
            allDeviceNames.forEach(name => {
                // Check if already exists as recording device (case-insensitive comparison)
                const isAlreadyRecording = recordingDeviceNames.has(name.toLowerCase());
                
                if (!isAlreadyRecording) {
                    // Determine if it's input (Input) or output (Output/Playback)
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
            console.warn('[Audio] Could not list devices via Get-PnpDevice:', error.message);
        }
        
        if (devices.length === 0) {
            devices.push({
                id: 0,
                name: 'No devices found',
                type: 'none',
                displayName: 'No devices found',
                isRecording: false,
                isPlayback: false
            });
        }
        
        // Sort: Recording first (most useful for capture), then playback
        devices.sort((a, b) => {
            if (a.isRecording && !b.isRecording) return -1;
            if (!a.isRecording && b.isRecording) return 1;
            return a.name.localeCompare(b.name);
        });
        
        // Reindex after sorting
        devices.forEach((d, i) => d.id = i);
        
        this.cachedDevices = devices;
        console.log(`[Audio] ${devices.length} device(s) found:`);
        console.log(`  - Recording: ${devices.filter(d => d.isRecording).length}`);
        console.log(`  - Playback: ${devices.filter(d => d.isPlayback).length}`);
        return devices;
    }
    
    _parseAudioDevices(output) {
        const devices = [];
        const lines = output.split('\n');
        
        for (const line of lines) {
            // Search lines with "(audio)" that indicate audio devices
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
            console.log(`[Audio] Device selected: ${device.displayName} (ID: ${numericId})`);
        } else {
            console.warn(`[Audio] Device with ID ${numericId} not found`);
        }
        
        this.emit('statusChange');
        return device;
    }
    
    startCapture() {
        if (this._isCapturing) {
            console.log('[Audio] Already capturing');
            return this.audioStream;
        }
        
        const device = this.getCurrentDevice();
        if (!device) {
            console.error('[Audio] No audio device available');
            return null;
        }
        
        if (!ffmpegPath) {
            console.error('[Audio] FFmpeg not available');
            return null;
        }
        
        if (device.type === 'loopback-hint') {
            console.error('[Audio] Please enable "Stereo Mix" in Windows Control Panel');
            console.error('[Audio] Control Panel > Sound > Recording > Stereo Mix > Enable');
            return null;
        }
        
        // Create passthrough stream with buffer for stability
        this.audioStream = new PassThrough({
            highWaterMark: 9600  // 100ms buffer at 48kHz stereo 16-bit for stability
        });
        
        console.log(`[Audio] Starting capture from: ${device.displayName}`);
        
        // Optimized FFmpeg arguments for minimal latency
        // For virtual-audio-capturer, use special settings
        let args;
        
        if (device.name.toLowerCase().includes('virtual-audio-capturer')) {
            // virtual-audio-capturer may need specific settings
            args = [
                '-f', 'dshow',
                '-audio_buffer_size', '50',          // Larger buffer for stability
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
            // Balanced configuration - stability vs latency
            args = [
                '-f', 'dshow',
                '-audio_buffer_size', '30',          // 30ms buffer for stability
                '-i', `audio=${device.name}`,
                '-acodec', 'pcm_s16le',
                '-ar', '48000',
                '-ac', '2',
                '-flush_packets', '1',               // Send packets immediately
                '-fflags', '+nobuffer+flush_packets',
                '-flags', 'low_delay',               // Low latency mode
                '-probesize', '32',                  // Minimal analysis
                '-analyzeduration', '0',             // No duration analysis
                '-f', 's16le',
                '-'
            ];
        }
        
        console.log(`[Audio] FFmpeg: ${args.join(' ')}`);
        
        this.ffmpegProcess = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let dataReceived = false;
        let bytesReceived = 0;
        
        // Transmit data immediately without additional buffering
        this.ffmpegProcess.stdout.on('data', (data) => {
            if (!dataReceived) {
                dataReceived = true;
                console.log(`[Audio] First data received from device`);
            }
            bytesReceived += data.length;
            if (this.audioStream && !this.audioStream.destroyed) {
                this.audioStream.write(data);
            }
        });
        
        // Periodic byte count log for diagnostics (debug mode only)
        if (process.argv.includes('--debug') || process.env.DEBUG === 'true') {
            this._statsInterval = setInterval(() => {
                if (this._isCapturing) {
                    console.log(`[Audio] Bytes received: ${(bytesReceived / 1024).toFixed(1)} KB`);
                }
            }, 5000);
        }
        
        this.ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            // Show more information for diagnostics
            if (msg.toLowerCase().includes('error')) {
                console.error(`[FFmpeg ERRO] ${msg.trim()}`);
            } else if (msg.includes('Stream') || msg.includes('Audio')) {
                console.log(`[FFmpeg] ${msg.trim()}`);
            }
        });
        
        this.ffmpegProcess.on('error', (error) => {
            console.error('[Audio] Error starting FFmpeg:', error.message);
            this._isCapturing = false;
            this.emit('statusChange');
        });
        
        this.ffmpegProcess.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.log(`[Audio] FFmpeg exited with code: ${code}`);
            }
            if (this._isCapturing) {
                this._isCapturing = false;
                this.emit('statusChange');
            }
        });
        
        this._isCapturing = true;
        console.log(`[Audio] Capture started: ${device.displayName}`);
        this.emit('statusChange');
        
        return this.audioStream;
    }
    
    stopCapture() {
        if (!this._isCapturing) return;
        
        console.log('[Audio] Stopping capture...');
        
        // Stop stats interval
        if (this._statsInterval) {
            clearInterval(this._statsInterval);
            this._statsInterval = null;
        }
        
        // Stop test tone interval if it exists
        if (this.toneInterval) {
            clearInterval(this.toneInterval);
            this.toneInterval = null;
        }
        
        // Stop FFmpeg process
        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill('SIGTERM');
            } catch (error) {
                // Ignore errors when killing process
            }
            this.ffmpegProcess = null;
        }
        
        // Close stream
        if (this.audioStream) {
            try {
                this.audioStream.end();
            } catch (error) {
                // Ignore errors
            }
            this.audioStream = null;
        }
        
        this._isCapturing = false;
        console.log('[Audio] Capture stopped');
        this.emit('statusChange');
    }
    
    isCapturing() {
        return this._isCapturing;
    }
    
    // Generate test tone (440Hz sine wave) - for debug
    generateTestTone(durationMs = 5000) {
        console.log('[Audio] Generating test tone...');
        this.audioStream = new PassThrough({
            highWaterMark: 960
        });
        this._isCapturing = true;
        
        const sampleRate = 48000;
        const channels = 2;
        const frequency = 440; // Hz (A4 note)
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
                
                // Write to both channels (stereo)
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
