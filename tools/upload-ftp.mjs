// Lädt die Portable-Build aus package-output/ per SFTP hoch.
// Aufruf: npm run upload:ftp   (liest Zugangsdaten aus .env via node --env-file)
// Lädt zwei Dateien: die versionierte Portable + eine feste "latest"-Kopie.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Client from 'ssh2-sftp-client';

const {
  SFTP_HOST,
  SFTP_PORT = '22',
  SFTP_USER,
  SFTP_PASSWORD,
  SFTP_REMOTE_PATH = '.',
} = process.env;

for (const [key, value] of Object.entries({ SFTP_HOST, SFTP_USER, SFTP_PASSWORD })) {
  if (!value) {
    console.error(`Fehlende Umgebungsvariable: ${key}. Lege eine .env an (siehe .env.example).`);
    process.exit(1);
  }
}

// Datei versions-genau aus package.json wählen (nicht "erstbeste" aus dem Verzeichnis).
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const portable = `QuotaBar-${version}-portable.exe`;
const localFile = join('package-output', portable);
if (!existsSync(localFile)) {
  console.error(`${localFile} nicht gefunden. Zuerst "npm run package" ausführen.`);
  process.exit(1);
}

// Basis-Pfad normalisieren: trailing slashes weg; "." / "" -> Login-Home.
const base = SFTP_REMOTE_PATH.replace(/\/+$/, '');
const remoteDir = base === '' || base === '.' ? '.' : base;
const remoteVersioned = `${remoteDir}/${portable}`;
const remoteLatest = `${remoteDir}/QuotaBar-portable.exe`;

const sftp = new Client();
try {
  console.log(`Verbinde mit ${SFTP_HOST}:${SFTP_PORT} als ${SFTP_USER} ...`);
  await sftp.connect({
    host: SFTP_HOST,
    port: Number(SFTP_PORT),
    username: SFTP_USER,
    password: SFTP_PASSWORD,
  });

  if (remoteDir !== '.' && !(await sftp.exists(remoteDir))) {
    console.log(`Erstelle Zielverzeichnis ${remoteDir} ...`);
    await sftp.mkdir(remoteDir, true);
  }

  console.log(`Lade ${localFile} -> ${remoteVersioned}`);
  await sftp.put(localFile, remoteVersioned);

  console.log(`Lade latest-Kopie -> ${remoteLatest}`);
  await sftp.put(localFile, remoteLatest);

  const listing = await sftp.list(remoteDir);
  console.log(`\nInhalt von ${remoteDir}:`);
  for (const item of listing) {
    console.log(`  ${item.name}  (${item.size} Bytes)`);
  }
  console.log('\nUpload abgeschlossen.');
} catch (err) {
  console.error('Upload fehlgeschlagen:', err.message);
  process.exitCode = 1;
} finally {
  await sftp.end();
}
