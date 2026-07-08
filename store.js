// store.js
// トークルーム(グループ/複数人トーク/個人)ごとに以下を永続化するストレージ層。
//   - ワードごとの累計出現回数・最後に発言したユーザーID・時刻
//   - 検出の一時停止(paused)状態
//
// 本番でサーバーレス環境(Vercel Functions, AWS Lambdaなど)にデプロイする場合、
// ローカルファイルシステムは実行のたびにリセットされることがあるため、
// Redis / Firestore / DynamoDBなどの外部DBに置き換えることを推奨します。
// (このファイルの関数群と同じインターフェースを保てば index.js 側の変更は不要です)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'counts.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');
  }
}

// 旧バージョン(ワード名 -> 回数 or 統計オブジェクト、という形式)との後方互換性を保つための正規化
function normalizeWordEntry(entry) {
  if (typeof entry === 'number') {
    return { count: entry, lastUserId: null, lastTimestamp: null };
  }
  return {
    count: (entry && entry.count) || 0,
    lastUserId: (entry && entry.lastUserId) || null,
    lastTimestamp: (entry && entry.lastTimestamp) || null,
  };
}

// 旧形式 (sourceIdの直下にワード名のマップが直接あった形式) と
// 新形式 ({ paused, words: {...} }) の両方を読み込めるようにする
function normalizeSourceEntry(entry) {
  if (!entry) {
    return { paused: false, words: {} };
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'words')) {
    const words = {};
    for (const word of Object.keys(entry.words)) {
      words[word] = normalizeWordEntry(entry.words[word]);
    }
    return { paused: !!entry.paused, words };
  }
  // 旧形式: entry自体が { ワード名: 統計 } のマップだった
  const words = {};
  for (const word of Object.keys(entry)) {
    words[word] = normalizeWordEntry(entry[word]);
  }
  return { paused: false, words };
}

function loadAll() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
    const normalized = {};
    for (const sourceId of Object.keys(data)) {
      normalized[sourceId] = normalizeSourceEntry(data[sourceId]);
    }
    return normalized;
  } catch (err) {
    console.error('counts.jsonの読み込みに失敗したため、空データとして扱います:', err);
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureSource(data, sourceId) {
  if (!data[sourceId]) data[sourceId] = { paused: false, words: {} };
  return data[sourceId];
}

/**
 * 指定したトークルーム・ワードの現在の統計情報を取得する
 * @returns {{count: number, lastUserId: string|null, lastTimestamp: number|null}}
 */
function getWordStats(sourceId, word) {
  const data = loadAll();
  const source = data[sourceId];
  if (!source || !source.words[word]) {
    return { count: 0, lastUserId: null, lastTimestamp: null };
  }
  return source.words[word];
}

/**
 * ワードの出現を occurrences 回分カウントに加算し、
 * userId が渡された場合は「最後に発言したユーザー」も更新する。
 * 更新後の統計情報を返す。
 */
function recordWordOccurrence(sourceId, word, occurrences, userId, timestamp) {
  const data = loadAll();
  const source = ensureSource(data, sourceId);
  const current = source.words[word] || { count: 0, lastUserId: null, lastTimestamp: null };

  current.count += occurrences;
  if (userId) {
    current.lastUserId = userId;
    current.lastTimestamp = timestamp || Date.now();
  }

  source.words[word] = current;
  saveAll(data);
  return current;
}

/**
 * 指定したトークルームの、指定したワードのカウント・最終発言者情報をリセットする
 */
function resetWord(sourceId, word) {
  const data = loadAll();
  const source = ensureSource(data, sourceId);
  delete source.words[word];
  saveAll(data);
}

/**
 * 指定したトークルームの、全ワードのカウント・最終発言者情報をリセットする
 */
function resetAllWordsForSource(sourceId) {
  const data = loadAll();
  const source = ensureSource(data, sourceId);
  source.words = {};
  saveAll(data);
}

/**
 * 全てのトークルーム・全てのワードのカウントをリセットする(定期リセット用)。
 * 一時停止(paused)状態には影響しない。
 */
function resetEverything() {
  const data = loadAll();
  for (const sourceId of Object.keys(data)) {
    data[sourceId].words = {};
  }
  saveAll(data);
}

/**
 * 指定したトークルームで、ワード検出が一時停止中かどうかを取得する
 */
function isPaused(sourceId) {
  const data = loadAll();
  return !!(data[sourceId] && data[sourceId].paused);
}

/**
 * 指定したトークルームの、ワード検出の一時停止状態を設定する
 */
function setPaused(sourceId, paused) {
  const data = loadAll();
  const source = ensureSource(data, sourceId);
  source.paused = paused;
  saveAll(data);
}

/**
 * 指定したトークルームの全ワードの統計を取得する（デバッグ・拡張用）
 */
function getAllForSource(sourceId) {
  const data = loadAll();
  return (data[sourceId] && data[sourceId].words) || {};
}

module.exports = {
  getWordStats,
  recordWordOccurrence,
  resetWord,
  resetAllWordsForSource,
  resetEverything,
  isPaused,
  setPaused,
  getAllForSource,
};
