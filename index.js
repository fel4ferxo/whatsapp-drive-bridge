const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');

// Configurar el servidor HTTP para mantener el servicio activo
const app = express();
const PORT = process.env.PORT || 3000;

// Endpoint para recibir pings y mantener el servidor activo
app.get('/ping', (req, res) => {
  res.send('Servidor activo');
});

// Iniciar el servidor HTTP
app.listen(PORT, () => {
  console.log(`Servidor HTTP iniciado en el puerto ${PORT} para mantener el servicio activo.`);
});

// Números principal y secundario
const MAIN_NUMBER = '923838671'; // Sin el prefijo +
const SECONDARY_NUMBER = '51906040838'; // Número secundario fijo, con prefijo +51

// Configuración para evitar bloqueos
const MESSAGE_LIMIT_PER_MINUTE = 10; // Máximo 10 mensajes por minuto
const MESSAGE_LIMIT_PER_HOUR = 100; // Máximo 100 mensajes por hora
const MIN_DELAY_MS = 1000; // Retraso mínimo de 1 segundo entre mensajes
const MAX_DELAY_MS = 5000; // Retraso máximo de 5 segundos entre mensajes

// Variables para rastrear mensajes y evitar bloqueos
let messageCountPerMinute = 0;
let messageCountPerHour = 0;
let lastMessageContent = '';
let lastMessageTimestamp = Date.now();
let isPaused = false;

// Resetear contadores cada minuto y hora
setInterval(() => {
  messageCountPerMinute = 0;
}, 60 * 1000); // Cada minuto
setInterval(() => {
  messageCountPerHour = 0;
  isPaused = false; // Reanudar si estaba pausado
  console.log('Contador de mensajes por hora reiniciado.');
}, 60 * 60 * 1000); // Cada hora

// Función para generar un retraso aleatorio
function getRandomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

// Función para pausar la ejecución (usada para retrasos)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToWhatsApp() {
  // Configurar la autenticación (almacenar en /tmp para evitar problemas de permisos en Render)
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/whatsapp-auth');

  // Crear el cliente de WhatsApp con configuración personalizada
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Vamos a manejar el QR manualmente
    qrTimeout: 60000, // Tiempo de espera para escanear el QR: 60 segundos
    connectTimeoutMs: 60000, // Aumentar el tiempo de espera para la conexión a 60 segundos
    keepAliveIntervalMs: 30000, // Enviar keep-alive cada 30 segundos para mantener la conexión
    syncFullHistory: false, // Desactivar la sincronización completa del historial
  });

  // Mostrar el QR para autenticación
  let qrAttempts = 0;
  const maxQRAattempts = 5; // Número máximo de intentos para generar QRs

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrAttempts++;
      if (qrAttempts > maxQRAattempts) {
        console.log(`Se alcanzó el número máximo de intentos (${maxQRAattempts}) para generar QRs. Reiniciando conexión...`);
        sock.end(); // Forzar el cierre de la conexión para reiniciar
        return;
      }
      console.log(`Intento de QR ${qrAttempts}/${maxQRAattempts}. Escanea este QR con WhatsApp (número principal: 923838671):`);
      qrcode.generate(qr, { small: true }, (code) => {
        console.log('QR generado en los logs. Escanea con el número principal dentro de 60 segundos.');
        console.log(code);
      });
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado. Número principal: 923838671');
      qrAttempts = 0; // Reiniciar el contador de intentos
      // Enviar mensaje de prueba al secundario
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
        // Retraso exponencial para reconexión (mínimo 5 segundos, máximo 30 segundos)
        const reconnectDelay = Math.min(30000, 5000 * (lastDisconnect?.error?.output?.retryCount || 1));
        console.log(`Esperando ${reconnectDelay / 1000} segundos antes de reconectar...`);
        await delay(reconnectDelay);
        connectToWhatsApp();
      }
    }
  });

  // Guardar las credenciales cuando se actualicen
  sock.ev.on('creds.update', saveCreds);

  // Manejar errores de sincronización del estado
  sock.ev.on('chats.set', async () => {
    try {
      console.log('Sincronizando estado de chats...');
    } catch (error) {
      console.error('Error al sincronizar estado de chats:', error);
      if (error.message.includes('failed to sync state')) {
        console.log('Forzando reconexión debido a error de sincronización...');
        sock.end(); // Forzar cierre de la conexión
      }
    }
  });

  // Manejar errores de stream (como el código 515)
  sock.ev.on('connection.update', (update) => {
    if (update.lastDisconnect?.error?.message?.includes('Stream Errored')) {
      console.log('Error de stream detectado. Forzando reconexión...');
      sock.end(); // Forzar cierre de la conexión
    }
  });

  // Reenviar mensajes recibidos por el número principal al secundario
  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages;
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
        const senderNumber = msg.key.remoteJid.split('@')[0];
        if (senderNumber === MAIN_NUMBER) {
          console.log(`Mensaje ignorado: proviene de ${senderNumber}`);
          continue;
        }

        // Verificar límites de mensajes
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

        // Incluir el número de origen en el mensaje reenviado
        const originMessage = `\n\nRecibido por: ${senderNumber}`;

        // Manejar mensajes duplicados
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

        // Agregar retraso aleatorio para simular comportamiento humano
        const delayMs = getRandomDelay();
        console.log(`Aplicando retraso de ${delayMs}ms antes de reenviar el mensaje...`);
        await delay(delayMs);

        // Manejar diferentes tipos de mensajes
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

// Iniciar la conexión
connectToWhatsApp();