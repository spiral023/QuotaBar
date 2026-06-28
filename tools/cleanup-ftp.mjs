// Entfernt veraltete versionierte QuotaBar-Binaries vom IONOS-SFTP und behält
// nur die aktuelle Version (aus package.json) plus die festen "latest"-Dateien.
// Aufruf: node --env-file=.env tools/cleanup-ftp.mjs [--dry-run]
//
// Sicherheits-Design: löscht AUSSCHLIESSLICH Dateien, die exakt dem Muster
// QuotaBar-<semver>-(portable.exe|setup.exe|win.zip) entsprechen und NICHT die
// aktuelle Version sind. Alle anderen Dateien (latest-Kopien, sonstige Inhalte)
// bleiben unangetastet.

import { readFileSync } from 'node:fs';
import Client from 'ssh2-sftp-client';

const DRY_RUN = process.argv.includes('--dry-run');

const {
  SFTP_HOST,
  SFTP_PORT = '22',
  SFTP_USER,
  SFTP_PASSWORD,
  SFTP_REMOTE_PATH = '.',
} = process.env;

for (const [key, value] of Object.entries({ SFTP_HOST, SFTP_USER, SFTP_PASSWORD })) {
  if (!value) {
    console.error(`Fehlende Umgebungsvariable: ${key}.`);
    process.exit(1);
  }
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Nur versionierte Build-Artefakte mit ABWEICHENDER Version werden gelöscht.
const VERSIONED = /^QuotaBar-(\d+\.\d+\.\d+)-(portable\.exe|setup\.exe|win\.zip)$/;

const base = SFTP_REMOTE_PATH.replace(/\/+$/, '');
const remoteDir = base === '' || base === '.' ? '.' : base;

const sftp = new Client();
try {
  console.log(`Verbinde mit ${SFTP_HOST}:${SFTP_PORT} als ${SFTP_USER} ...`);
  await sftp.connect({
    host: SFTP_HOST,
    port: Number(SFTP_PORT),
    username: SFTP_USER,
    password: SFTP_PASSWORD,
  });

  const listing = await sftp.list(remoteDir);
  const toDelete = [];
  console.log(`\nInhalt von ${remoteDir} (aktuelle Version: ${version}):`);
  for (const item of listing) {
    const m = item.name.match(VERSIONED);
    const old = m && m[1] !== version;
    console.log(`  ${old ? '[DELETE]' : '[keep]  '} ${item.name}  (${item.size} Bytes)`);
    if (old) toDelete.push(item.name);
  }

  if (toDelete.length === 0) {
    console.log('\nKeine veralteten Binaries gefunden.');
  } else if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Würde ${toDelete.length} Datei(en) löschen.`);
  } else {
    console.log(`\nLösche ${toDelete.length} veraltete Datei(en) ...`);
    for (const name of toDelete) {
      await sftp.delete(`${remoteDir}/${name}`);
      console.log(`  gelöscht: ${name}`);
    }
  }
  console.log('\nFertig.');
} catch (err) {
  console.error('Cleanup fehlgeschlagen:', err.message);
  process.exitCode = 1;
} finally {
  await sftp.end();
}
