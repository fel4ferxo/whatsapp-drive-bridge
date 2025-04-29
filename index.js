const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage, BufferJSON } = require('baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { Client } = require('pg');

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
let isFirstConnection = true;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isConnecting = false; // Bandera para evitar múltiples intentos de reconexión simultáneos

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
  if (isConnecting) {
    console.log('Ya se está intentando una conexión. Ignorando nuevo intento...');
    return;
  }
  isConnecting = true;

  // Conectar a PostgreSQL (Neon)
  const pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await pgClient.connect();

  // Cargar o inicializar sesiones desde Neon
  const sessionId = 'whatsapp_session';
  let authState;
  let saveCreds;

  try {
    const result = await pgClient.query('SELECT creds FROM sessions WHERE id = $1', [sessionId]);
    if (result.rows.length > 0) {
      console.log('Cargando credenciales desde Neon...');
      const savedCreds = JSON.parse(result.rows[0].creds, BufferJSON.reviver);
      const { state, saveCreds: save } = await useMultiFileAuthState('/tmp/whatsapp-auth');
      authState = {
        creds: savedCreds,
        keys: state.keys
      };
      saveCreds = save;
      console.log('Credenciales cargadas exitosamente desde Neon:', JSON.stringify(savedCreds, null, 2));
    } else {
      console.log('No se encontraron credenciales en Neon. Inicializando nuevo estado...');
      const { state, saveCreds: save } = await useMultiFileAuthState('/tmp/whatsapp-auth');
      authState = state;
      saveCreds = save;
    }
  } catch (err) {
    console.error('Error al cargar credenciales desde Neon:', err);
    console.log('Inicializando nuevo estado debido al error...');
    const { state, saveCreds: save } = await useMultiFileAuthState('/tmp/whatsapp-auth');
    authState = state;
    saveCreds = save;
  }

  const sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    qrTimeout: 30000,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000, // Reducido a 30 segundos para mantener la conexión viva más activamente
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
    markOnlineOnConnect: false, // Deshabilitar para reducir actividad sospechosa
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        };
      }
      return message;
    },
  });

  // Guardar credenciales en Neon
  sock.ev.on('creds.update', async () => {
    if (saveCreds) await saveCreds();
    const creds = JSON.stringify(sock.authState.creds, BufferJSON.replacer);
    try {
      await pgClient.query(
        'INSERT INTO sessions (id, creds) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET creds = $2',
        [sessionId, creds]
      );
      console.log('Credenciales guardadas en PostgreSQL');
    } catch (err) {
      console.error('Error al guardar credenciales:', err);
    }
  });

  let qrAttempts = 0;
  const maxQRAattempts = 5;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      qrAttempts++;
      if (qrAttempts > maxQRAattempts) {
        console.log(`Se alcanzó el número máximo de intentos (${maxQRAattempts}) para generar QRs. Reiniciando conexión...`);
        sock.end();
        isConnecting = false;
        return;
      }
      console.log(`Intento de QR ${qrAttempts}/${maxQRAattempts}. Escanea este QR con WhatsApp (número principal: ${MAIN_NUMBER}):`);
      qrcode.generate(qr, { small: true }, (code) => {
        console.log('QR generado en los logs. Escanea con el número principal dentro de 30 segundos.');
        console.log(code);
      });
    }

    if (connection === 'open') {
      console.log(`WhatsApp conectado. Número principal: ${MAIN_NUMBER}, Nueva sesión: ${isNewLogin}`);
      qrAttempts = 0;
      reconnectAttempts = 0;
      if (isFirstConnection) {
        try {
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: 'Bot conectado exitosamente.' });
          console.log(`Mensaje de prueba enviado a ${SECONDARY_NUMBER}`);
          isFirstConnection = false;
        } catch (error) {
          console.error(`Error al enviar mensaje de prueba a ${SECONDARY_NUMBER}:`, error);
        }
      } else {
        console.log('Reconexión detectada. No se enviará mensaje de prueba.');
      }
      isConnecting = false;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Desconocido';
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Conexión cerrada. Razón: ${reason}, Código: ${statusCode}, Reconectando: ${shouldReconnect}`);

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.log(`Se alcanzó el número máximo de intentos de reconexión (${MAX_RECONNECT_ATTEMPTS}). Deteniendo reconexiones automáticas...`);
          console.log('Por favor, verifica manualmente si hay conflictos de sesión en WhatsApp (Ajustes > Dispositivos Vinculados).');
          isConnecting = false;
          return;
        }
        const baseDelay = 15000; // Retraso base de 15 segundos
        const exponentialBackoff = Math.pow(2, reconnectAttempts) * baseDelay; // Retraso exponencial
        const reconnectDelay = Math.min(120000, exponentialBackoff); // Máximo 2 minutos
        console.log(`Intento de reconexión ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}. Esperando ${reconnectDelay / 1000} segundos antes de reconectar...`);
        await delay(reconnectDelay);
        connectToWhatsApp();
      } else {
        console.log('Sesión cerrada por logout. Limpiando credenciales en Neon...');
        await pgClient.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
        isConnecting = false;
      }
    }
  });

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
        } else if (msg.message?.extendedTextMessage?.text) {
          console.log(`Mensaje de texto extendido recibido de ${senderNumber}: ${messageContent}`);
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: messageContent + originMessage });
          console.log(`Mensaje de texto extendido reenviado a ${SECONDARY_NUMBER}: ${messageContent}`);
        } else if (msg.message?.imageMessage) {
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
        } else if (msg.message?.documentMessage) {
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
        } else if (msg.message?.videoMessage) {
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
        } else {
          console.log(`Mensaje de tipo no manejado recibido de ${senderNumber}:`, msg.message);
        }
      }
    }
  });
}

connectToWhatsApp();