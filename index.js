const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((err, req, res, next) => {
  console.error('Error en el servidor:', err);
  res.status(500).send('Error interno del servidor');
});

app.get('/ping', (req, res) => {
  res.send('Servidor activo');
});

app.use((req, res) => {
  res.status(404).send('Ruta no encontrada. Usa /ping para verificar el estado del servidor.');
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP iniciado en el puerto ${PORT} para mantener el servicio activo.`);
});

const MAIN_NUMBER = '923838671';
const SECONDARY_NUMBER = '51906040838';
const MESSAGE_LIMIT_PER_MINUTE = 10;
const MESSAGE_LIMIT_PER_HOUR = 100;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;

let messageCountPerMinute = 0;
let messageCountPerHour = 0;
let lastMessageContent = '';
let lastMessageTimestamp = Date.now();
let isPaused = false;

setInterval(() => {
  messageCountPerMinute = 0;
}, 60 * 1000);
setInterval(() => {
  messageCountPerHour = 0;
  isPaused = false;
  console.log('Contador de mensajes por hora reiniciado.');
}, 60 * 60 * 1000);

function getRandomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/whatsapp-auth');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    qrTimeout: 5000, // Reducir a 5 segundos para evitar timeout de Vercel
    connectTimeoutMs: 5000, // Reducir a 5 segundos
    keepAliveIntervalMs: 10000, // Enviar keep-alive cada 10 segundos
    syncFullHistory: false,
  });

  let qrAttempts = 0;
  const maxQRAattempts = 5;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrAttempts++;
      if (qrAttempts > maxQRAattempts) {
        console.log(`Se alcanzó el número máximo de intentos (${maxQRAattempts}) para generar QRs. Reiniciando conexión...`);
        sock.end();
        return;
      }
      console.log(`Intento de QR ${qrAttempts}/${maxQRAattempts}. Escanea este QR con WhatsApp (número principal: 923838671):`);
      qrcode.generate(qr, { small: true }, (code) => {
        console.log('QR generado en los logs. Escanea con el número principal dentro de 5 segundos.');
        console.log(code);
      });
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado. Número principal: 923838671');
      qrAttempts = 0;
      try {
        await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: 'Bot conectado exitosamente.' });
        console.log(`Mensaje de prueba enviado a ${SECONDARY_NUMBER}`);
      } catch (error) {
        console.error(`Error al enviar mensaje de prueba a ${SECONDARY_NUMBER}:`, error);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada:', lastDisconnect?.error, 'Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        const reconnectDelay = Math.min(30000, 5000 * (lastDisconnect?.error?.output?.retryCount || 1));
        console.log(`Esperando ${reconnectDelay / 1000} segundos antes de reconectar...`);
        await delay(reconnectDelay);
        connectToWhatsApp();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('chats.set', async () => {
    try {
      console.log('Sincronizando estado de chats...');
    } catch (error) {
      console.error('Error al sincronizar estado de chats:', error);
      if (error.message.includes('failed to sync state')) {
        console.log('Forzando reconexión debido a error de sincronización...');
        sock.end();
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    if (update.lastDisconnect?.error?.message?.includes('Stream Errored')) {
      console.log('Error de stream detectado. Forzando reconexión...');
      sock.end();
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages;
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
        const senderNumber = msg.key.remoteJid.split('@')[0];
        if (senderNumber === MAIN_NUMBER) {
          console.log(`Mensaje ignorado: proviene de ${senderNumber}`);
          continue;
        }

        if (isPaused) {
          console.log('Reenvío pausado: se excedió el límite de mensajes por hora.');
          continue;
        }

        messageCountPerMinute++;
        messageCountPerHour++;
        if (messageCountPerMinute > MESSAGE_LIMIT_PER_MINUTE) {
          console.log('Límite de mensajes por minuto excedido. Pausando reenvío temporalmente.');
          continue;
        }
        if (messageCountPerHour > MESSAGE_LIMIT_PER_HOUR) {
          console.log('Límite de mensajes por hora excedido. Pausando reenvío hasta la próxima hora.');
          isPaused = true;
          continue;
        }

        const originMessage = `\n\nRecibido por: ${senderNumber}`;
        let messageContent = '';
        if (msg.message?.conversation) {
          messageContent = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          messageContent = msg.message.extendedTextMessage.text;
        }
        if (messageContent && messageContent === lastMessageContent && (Date.now() - lastMessageTimestamp) < 30000) {
          console.log(`Mensaje duplicado detectado de ${senderNumber}: ${messageContent}. Ignorando.`);
          continue;
        }
        lastMessageContent = messageContent || '';
        lastMessageTimestamp = Date.now();

        const delayMs = getRandomDelay();
        console.log(`Aplicando retraso de ${delayMs}ms antes de reenviar el mensaje...`);
        await delay(delayMs);

        if (msg.message?.conversation) {
          console.log(`Mensaje de texto recibido de ${senderNumber}: ${messageContent}`);
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: messageContent + originMessage });
          console.log(`Mensaje de texto reenviado a ${SECONDARY_NUMBER}: ${messageContent}`);
        }
        else if (msg.message?.extendedTextMessage?.text) {
          console.log(`Mensaje de texto extendido recibido de ${senderNumber}: ${messageContent}`);
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: messageContent + originMessage });
          console.log(`Mensaje de texto extendido reenviado a ${SECONDARY_NUMBER}: ${messageContent}`);
        }
        else if (msg.message?.imageMessage) {
          console.log(`Imagen recibida de ${senderNumber}`);
          const caption = (msg.message.imageMessage.caption || '') + originMessage;
          const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, {
            image: buffer,
            caption: caption,
          });
          console.log(`Imagen reenviada a ${SECONDARY_NUMBER} con caption: ${caption}`);
        }
        else if (msg.message?.documentMessage) {
          console.log(`Documento recibido de ${senderNumber}`);
          const fileName = msg.message.documentMessage.fileName || 'documento';
          const stream = await downloadContentFromMessage(msg.message.documentMessage, 'document');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, {
            document: buffer,
            mimetype: msg.message.documentMessage.mimetype,
            fileName: fileName,
            caption: originMessage,
          });
          console.log(`Documento reenviado a ${SECONDARY_NUMBER}: ${fileName}`);
        }
        else if (msg.message?.videoMessage) {
          console.log(`Video recibido de ${senderNumber}`);
          const caption = (msg.message.videoMessage.caption || '') + originMessage;
          const stream = await downloadContentFromMessage(msg.message.videoMessage, 'video');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, {
            video: buffer,
            caption: caption,
          });
          console.log(`Video reenviado a ${SECONDARY_NUMBER} con caption: ${caption}`);
        }
        else {
          console.log(`Mensaje de tipo no manejado recibido de ${senderNumber}:`, msg.message);
        }
      }
    }
  });
}

connectToWhatsApp();