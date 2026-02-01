# Discord PA System

Um sistema profissional de Public Address (PA) para Discord que transmite áudio de qualquer dispositivo de entrada ou saída do computador para múltiplos canais de voz simultaneamente.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Discord.js](https://img.shields.io/badge/Discord.js-14.14-blue?logo=discord)

## ✨ Funcionalidades

- 🤖 **Múltiplos Bots** - Suporte para vários bots Discord funcionando simultaneamente
- 🎤 **Captura Universal de Áudio** - Captura de TODOS os dispositivos de áudio (entradas e saídas)
- 📡 **Transmissão Simultânea** - Transmite para múltiplos canais de voz ao mesmo tempo
- 🌐 **Interface Web Moderna** - Interface intuitiva para gestão completa
- ⚡ **Tempo Real** - Atualizações instantâneas via WebSocket
- 💾 **Configuração Persistente** - Guarda dispositivo de áudio e canais predefinidos
- 🎚️ **Voice Activity Detection (VAD)** - Os bots mostram indicador "a falar" apenas quando há som
- 🔄 **Auto-restauro** - Restaura automaticamente a última configuração ao iniciar

## 📋 Requisitos

- **Node.js 18** ou superior
- **FFmpeg** (incluído automaticamente via ffmpeg-static)
- **Windows** (para captura de dispositivos via DirectShow)
- Conta Discord com bots criados no [Discord Developer Portal](https://discord.com/developers/applications)

## 🚀 Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/IvoAndre/Discord-PA.git
cd Discord-PA
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure os tokens dos bots

Copie o ficheiro de exemplo:
```bash
cp .env.example .env
```

Edite o ficheiro `.env` e adicione os tokens dos seus bots:
```env
BOT_TOKENS=token_do_bot_1,token_do_bot_2,token_do_bot_3
PORT=3000
```

### 4. Inicie o servidor

```bash
npm start
```

### 5. Aceda à interface

Abra o navegador em **http://localhost:3000**

## 🤖 Criar um Bot Discord

1. Aceda ao [Discord Developer Portal](https://discord.com/developers/applications)
2. Clique em **"New Application"** e dê um nome
3. Vá a **"Bot"** no menu lateral
4. Clique em **"Reset Token"** e copie o token
5. Em **"Privileged Gateway Intents"**, ative:
   - ✅ Server Members Intent
6. Vá a **"OAuth2"** > **"URL Generator"**
7. Selecione os scopes: `bot`
8. Selecione as permissões: `Connect`, `Speak`, `View Channels`
9. Copie o URL gerado e abra-o para adicionar o bot aos seus servidores

> 💡 **Dica**: Crie múltiplos bots se precisar de transmitir para muitos canais simultaneamente. Cada bot pode estar em um canal de voz por servidor.

## 📖 Como Usar

1. **Inicie o servidor** com `npm start`
2. **Aceda à interface web** em `http://localhost:3000`
3. **Selecione um dispositivo de áudio** no dropdown (microfone, saída de sistema, etc.)
4. **Selecione um bot** e escolha um **servidor/canal de voz**
5. **Clique em "Entrar no Canal"** para conectar o bot
6. **Repita** para adicionar mais bots a outros canais
7. **Clique em "Iniciar Transmissão"** para começar a transmitir áudio
8. **Configure o VAD** se quiser que os bots só mostrem "a falar" quando há som

## 🎚️ Voice Activity Detection (VAD)

O VAD permite que os bots mostrem o indicador de "a falar" no Discord apenas quando há som real:

- **Ativar/Desativar**: Checkbox na interface
- **Threshold**: Sensibilidade do detetor (1-500, menor = mais sensível)
- **Timeout de Silêncio**: Tempo em ms antes de parar após silêncio (200-2000ms)

## 🔧 Comandos

| Comando | Descrição |
|---------|-----------|
| `npm start` | Inicia o servidor |
| `npm run dev` | Inicia em modo de desenvolvimento (auto-reload) |
| `npm run debug` | Inicia com logs de debug detalhados |

## 📁 Estrutura do Projeto

```
Discord-PA/
├── src/
│   ├── index.js           # Servidor principal (Express + WebSocket)
│   ├── audio/
│   │   └── AudioManager.js # Gestão de dispositivos e captura de áudio
│   ├── bot/
│   │   └── BotManager.js   # Gestão de bots e transmissão
│   ├── config/
│   │   └── ConfigManager.js # Configuração persistente
│   └── public/
│       └── index.html      # Interface web
├── .env.example            # Exemplo de configuração
├── package.json
└── README.md
```

## ⚙️ Variáveis de Ambiente

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `BOT_TOKENS` | Tokens dos bots separados por vírgula | (obrigatório) |
| `PORT` | Porta do servidor web | 3000 |

## 🛠️ Tecnologias

- **[discord.js](https://discord.js.org/)** - Biblioteca principal do Discord
- **[@discordjs/voice](https://www.npmjs.com/package/@discordjs/voice)** - Suporte a canais de voz
- **[Express](https://expressjs.com/)** - Servidor web
- **[WebSocket (ws)](https://www.npmjs.com/package/ws)** - Comunicação em tempo real
- **[ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)** - Captura e processamento de áudio
- **[opusscript](https://www.npmjs.com/package/opusscript)** - Codificação de áudio Opus

## 🐛 Resolução de Problemas

### O bot não entra no canal
- Verifique se o token do bot está correto no `.env`
- Verifique se o bot tem permissões `Connect` e `Speak` no servidor

### Não há som
- Verifique se selecionou o dispositivo de áudio correto
- Verifique se a transmissão está iniciada
- Se usar VAD, tente baixar o threshold

### Dispositivo de áudio não aparece
- Certifique-se que o dispositivo está ativo no Windows
- Reinicie o servidor para atualizar a lista
