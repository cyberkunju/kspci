// Copies client-package.json into the build output (dist/) so Catalyst
// Web Client Hosting picks it up. Runs as part of `npm run build`.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
fs.copyFileSync(path.join(__dirname, '..', 'client-package.json'), path.join(dist, 'client-package.json'));
// SPA deep-link support: 404 serves the same app shell so React Router can route.
fs.copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));
console.log('copied client-package.json + 404.html -> dist/');
