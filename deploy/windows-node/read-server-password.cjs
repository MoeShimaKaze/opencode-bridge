const Database = require('better-sqlite3');
const path = require('node:path');
const db = new Database(path.join(__dirname, 'data/config.db'), { readonly: true });
const settings = JSON.parse(db.prepare('select payload from settings where id=1').get().payload);
process.stdout.write(settings.OPENCODE_SERVER_PASSWORD);
db.close();
