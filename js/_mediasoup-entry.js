// Punto de entrada para generar el bundle de mediasoup-client para el navegador
// Se compila con: npx esbuild js/_mediasoup-entry.js --bundle --outfile=js/mediasoup-client.bundle.js --format=iife --global-name=mediasoupClient --minify
const mediasoupClient = require('mediasoup-client');
module.exports = mediasoupClient;
