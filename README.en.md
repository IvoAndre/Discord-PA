# <image src=".branding/Discord-PA.svg" height=25px/> Discord PA System

A professional Public Address (PA) system for Discord that broadcasts audio from any input or output device on the computer to multiple voice channels simultaneously.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Discord.js](https://img.shields.io/badge/Discord.js-14.14-blue?logo=discord)

## Features

- **Multiple Bots** — Support for multiple Discord bots running simultaneously
- **Universal Audio Capture** — Capture from ALL audio devices (inputs and outputs)
- **Simultaneous Broadcasting** — Broadcast to multiple voice channels at the same time
- **Modern Web Interface** — Intuitive interface for complete management
- **Real-Time** — Instant updates via WebSocket
- **Persistent Configuration** — Saves audio device and preset channels
- **Voice Activity Detection (VAD)** — Bots show "speaking" indicator only when there is actual sound
- **Auto-Restore** — Automatically restores the last configuration on startup
- **Internationalization** — Full EN-US and PT-PT language support with live switcher

## Requirements

- **Node.js 18** or higher
- **FFmpeg** (included automatically via ffmpeg-static)
- **Windows** (for device capture via DirectShow)
- Discord account with bots created at the [Discord Developer Portal](https://discord.com/developers/applications)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/IvoAndre/Discord-PA.git
cd Discord-PA
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure bot tokens

Copy the example file:
```bash
cp .env.example .env
```

Edit the `.env` file and add your bot tokens:
```env
BOT_TOKENS=bot_token_1,bot_token_2,bot_token_3
PORT=3000
```

### 4. Start the server

```bash
npm start
```

### 5. Access the interface

Open your browser at **http://localhost:3000**

## Creating a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** and give it a name
3. Go to **"Bot"** in the sidebar
4. Click **"Reset Token"** and copy the token
5. Under **"Privileged Gateway Intents"**, enable:
   - Server Members Intent
6. Go to **"OAuth2"** > **"URL Generator"**
7. Select the scopes: `bot`
8. Select the permissions: `Connect`, `Speak`, `View Channels`
9. Copy the generated URL and open it to add the bot to your servers

> **Tip**: Create multiple bots if you need to broadcast to many channels simultaneously. Each bot can be in one voice channel per server.

## How to Use

1. **Start the server** with `npm start`
2. **Access the web interface** at `http://localhost:3000`
3. **Select an audio device** from the dropdown (microphone, system output, etc.)
4. **Select a bot** and choose a **server/voice channel**
5. **Click "Join Channel"** to connect the bot
6. **Repeat** to add more bots to other channels
7. **Click "Start Broadcast"** to start streaming audio
8. **Configure the VAD** if you want bots to only show "speaking" when there is sound

## Voice Activity Detection (VAD)

VAD allows bots to show the "speaking" indicator in Discord only when there is actual sound:

- **Enable/Disable**: Checkbox in the interface
- **Threshold**: Detector sensitivity (1–500, lower = more sensitive)
- **Silence Timeout**: Time in ms before stopping after silence (200–2000 ms)

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the server |
| `npm run dev` | Start in development mode (auto-reload) |
| `npm run debug` | Start with detailed debug logs |

## Project Structure

```
Discord-PA/
├── src/
│   ├── index.js            # Main server (Express + WebSocket)
│   ├── audio/
│   │   └── AudioManager.js # Audio device management and capture
│   ├── bot/
│   │   └── BotManager.js   # Bot management and broadcasting
│   ├── config/
│   │   └── ConfigManager.js # Persistent configuration
│   └── public/
│       └── index.html       # Web interface
├── .env.example             # Example configuration
├── package.json
└── README.md
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKENS` | Comma-separated bot tokens | (required) |
| `PORT` | Web server port | 3000 |

## Technologies

- **[discord.js](https://discord.js.org/)** — Main Discord library
- **[@discordjs/voice](https://www.npmjs.com/package/@discordjs/voice)** — Voice channel support
- **[Express](https://expressjs.com/)** — Web server
- **[WebSocket (ws)](https://www.npmjs.com/package/ws)** — Real-time communication
- **[ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)** — Audio capture and processing
- **[opusscript](https://www.npmjs.com/package/opusscript)** — Opus audio encoding

## Troubleshooting

### The bot won't join the channel
- Check that the bot token is correct in `.env`
- Check that the bot has `Connect` and `Speak` permissions on the server

### No sound
- Make sure you selected the correct audio device
- Make sure the broadcast is started
- If using VAD, try lowering the threshold

### Audio device not showing
- Make sure the device is active in Windows
- Restart the server to refresh the list
