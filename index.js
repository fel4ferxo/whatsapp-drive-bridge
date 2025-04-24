const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Configuración del cliente de WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }), // Persistencia en Render
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', // Para Render
  },
});

// Número secundario al que se reenviarán los mensajes
const SECONDARY_NUMBER = '906040838@c.us'; // Formato: número@c.us

// Mostrar QR para autenticación
client.on('qr', (qr) => {
  console.log('Escanea este QR con WhatsApp:');
  qrcode.generate(qr, { small: true }, (code) => {
    console.log('QR generado en los logs. Escanea con tu número principal.');
    console.log(code); // Mostrar el QR explícitamente en los logs
  });
});

// Confirmar conexión y obtener el número principal
let MAIN_NUMBER = '';
client.on('ready', async () => {
  const user = await client.getContactById(client.info.wid._serialized);
  MAIN_NUMBER = user.id._serialized; // Número principal dinámico
  console.log(`WhatsApp conectado. Número principal: ${MAIN_NUMBER}`);
  // Enviar mensaje de prueba al secundario para confirmar conexión
  try {
    await client.sendMessage(SECONDARY_NUMBER, 'Bot conectado exitosamente.');
    console.log(`Mensaje de prueba enviado a ${SECONDARY_NUMBER}`);
  } catch (error) {
    console.error(`Error al enviar mensaje de prueba a ${SECONDARY_NUMBER}:`, error);
  }
});

// Reenviar mensajes recibidos por el número principal al secundario
client.on('message', async (msg) => {
  try {
    if (msg.from === MAIN_NUMBER || msg.fromMe) {
      console.log(`Mensaje ignorado: proviene de ${msg.from}`);
      return;
    }
    console.log(`Mensaje recibido de ${msg.from}: ${msg.body}`);
    // Reenviar el mensaje al número secundario
    await client.sendMessage(SECONDARY_NUMBER, msg.body);
    console.log(`Mensaje reenviado a ${SECONDARY_NUMBER} desde ${msg.from}`);
  } catch (error) {
    console.error('Error al reenviar mensaje:', error);
  }
});

// Manejar desconexiones
client.on('disconnected', (reason) => {
  console.log('Cliente desconectado:', reason);
  client.initialize();
});

// Iniciar el cliente
client.initialize();