// index.js
// LINE Messaging APIのWebhookを受け取り、トークルーム内の発言に
// 特定ワードが含まれていた回数をカウントして、都度トークルームに返信するBot。
//
// コマンド一覧:
//   !count ワード   → そのワードの累計出現回数を返信する
//   !lately ワード  → そのワードを直近に発言したユーザーの表示名を返信する
//   !reset ワード   → そのワードのカウントをリセットする(このトークルームのみ)
//   !all_reset      → このトークルームの全ワードのカウントをリセットする
//   !stop           → このトークルームでのワード検出を一時停止する
//   !start          → このトークルームでのワード検出を再開する
//   !state          → このトークルームでのワード検出が稼働中か停止中かを返信する
//
// また、毎日 12:00 と 24:00(=翌日0:00) に、全トークルーム・全ワードの
// カウントを自動的にリセットする(node-cronによる定期実行)。
//
// 参考: https://line.github.io/line-bot-sdk-nodejs/ (SDK v11系) / https://nodecron.com/ (node-cron v4系)

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { middleware, LineBotClient } = require('@line/bot-sdk');
const store = require('./store');

// ===================== 設定 =====================

// カウント対象ワード。.env の TARGET_WORDS にカンマ区切りで複数指定できる
// 例: TARGET_WORDS=ラーメン,カレー,神
// !count / !lately / !all_reset で参照・操作できるのも、ここに設定したワードが基準
const TARGET_WORDS = (process.env.TARGET_WORDS || 'ラーメン')
  .split(',')
  .map((w) => w.trim())
  .filter((w) => w.length > 0);

if (!process.env.CHANNEL_ACCESS_TOKEN || !process.env.CHANNEL_SECRET) {
  console.error(
    '環境変数 CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET が設定されていません。.envを確認してください。'
  );
  process.exit(1);
}

// Webhookの署名検証・パース用設定 (チャネルシークレットのみ必要)
const middlewareConfig = {
  channelSecret: process.env.CHANNEL_SECRET,
};

// メッセージ送信用クライアント (チャネルアクセストークンが必要)
const client = LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

const app = express();

// ===================== 定期リセット (毎日 12:00, 24:00) =====================
// cron式 '0 0,12 * * *' は「毎日 0分・0時 と 0分・12時」を意味する
// (24:00は翌日の0:00と同じ時刻のため、0時をもって表現する)
cron.schedule(
  '0 0 * * *',
  () => {
    store.resetEverything();
    console.log(
      `[${new Date().toISOString()}] 定期リセットを実行しました(全トークルーム・全ワードのカウントを0にしました)`
    );
  },
  { timezone: 'Asia/Tokyo', name: 'daily-word-count-reset' }
);

// ===================== Webhookエンドポイント =====================

app.post('/webhook', middleware(middlewareConfig), async (req, res) => {
  // LINEプラットフォームは数秒でタイムアウトするため、先に200を返却してから処理する
  res.sendStatus(200);

  const events = req.body.events || [];
  await Promise.all(
    events.map((event) =>
      handleEvent(event).catch((err) => {
        console.error('イベント処理中にエラーが発生しました:', err);
      })
    )
  );
});

// 動作確認用のヘルスチェック
app.get('/', (_req, res) => {
  res.send('LINE word counter bot is running.');
});

// ===================== イベント処理 =====================

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const text = event.message.text;
  const trimmed = text.trim();
  const sourceId = getSourceId(event.source);
  if (!sourceId) return;

  // ---- 管理コマンド群 (検出の一時停止中でも常に反応する) ----

  if (trimmed === '!state') {
    const paused = store.isPaused(sourceId);
    await reply(event.replyToken, [
      paused ? '今は検出止めてるよ' : '今は普通に検出してるよ',
    ]);
    return;
  }

  if (trimmed === '!start') {
    store.setPaused(sourceId, false);
    await reply(event.replyToken, ['検出再開するンゴ']);
    return;
  }

  if (trimmed === '!stop') {
    store.setPaused(sourceId, true);
    await reply(event.replyToken, [
      '検出を停止したよ   再開するには「!start」と発言しろください',
    ]);
    return;
  }

  if (trimmed === '!all_reset') {
    store.resetAllWordsForSource(sourceId);
    await reply(event.replyToken, [
      `このトークルームの全ワード(${TARGET_WORDS.join(', ')})のカウントをリセットしたンゴ`,
    ]);
    return;
  }

  const resetCommand = text.match(/^!reset\s*(.*)$/);
  if (resetCommand) {
    const word = resetCommand[1].trim();
    if (!word) {
      await reply(event.replyToken, [
        'リセットするワードを指定しろください。例:「!reset ラーメン」',
      ]);
      return;
    }
    store.resetWord(sourceId, word);
    const note = TARGET_WORDS.includes(word)
      ? ''
      : '(なお、このワードは現在のカウント対象には含まれていない希ガス)';
    await reply(event.replyToken, [`「${word}」のカウントをリセットしたンゴ${note}`]);
    return;
  }

  // ---- 問い合わせコマンド群 (検出の一時停止中でも常に反応する) ----

  const latelyCommand = text.match(/^!lately\s*(.*)$/);
  if (latelyCommand) {
    const word = latelyCommand[1].trim() || TARGET_WORDS[0];
    const stats = store.getWordStats(sourceId, word);

    if (!stats.lastUserId) {
      await reply(event.replyToken, [`「${word}」はまだ発言されていない希ガス`]);
      return;
    }

    const displayName = await getDisplayName(event.source, stats.lastUserId);
    const label = displayName || '(表示名を取得できませんでした。退出済みの可能性があります)';
    await reply(event.replyToken, [
      `直近で「${word}」を発言したのは ${label} さんだなあ、そうに決まってる`,
    ]);
    return;
  }

  const countCommand = text.match(/^!count\s*(.*)$/);
  if (countCommand) {
    const word = countCommand[1].trim() || TARGET_WORDS[0];
    const stats = store.getWordStats(sourceId, word);
    await reply(event.replyToken, [
      `「${word}」はこれまでに ${stats.count} 回発言されてるよ`,
    ]);
    return;
  }

  const helpCommand = text.match(/^!help\s*(.*)$/);
  if (helpCommand){
    await reply(event.replyToken, ['「!help」：コマンド一覧を表示する\n「!state」：今のbotの状態（稼働中か停止中か）を表示\n「!start」：botの検出を再開させる\n「!stop」：botの検出を一時停止する\n「!reset <ワード>」：任意のタイミングで<ワード>のカウントをリセットする\n「!all_reset」：任意のタイミングで検出対象のすべてのワードのカウントをリセットする\n「!lately <ワード>」：一番直近で<ワード>を発言した人を表示\n「!count <ワード>」：現在の<ワード>のカウントを表示\n\n毎日24:00に、すべてのワードのカウントが強制リセットされます']);
  }

  // ---- ここから先はワード検出処理。一時停止中は何もしない ----
  if (store.isPaused(sourceId)) {
    return;
  }

  // メッセージ本文に登場した対象ワードをそれぞれカウントし、最後に発言したユーザーも記録する
  const replyTexts = [];
  for (const word of TARGET_WORDS) {
    const occurrences = countOccurrences(text, word);
    if (occurrences > 0) {
      const stats = store.recordWordOccurrence(
        sourceId,
        word,
        occurrences,
        event.source.userId,
        event.timestamp
      );
      const thisTime =
        occurrences > 1 ? `(今回のメッセージで${occurrences}回)` : '';
      replyTexts.push(
        `「${word}」を検出しました！${thisTime} 累計 ${stats.count} 回目です`
      );
    }
  }

  if (replyTexts.length > 0) {
    // reply APIは1回のリクエストにつき最大5メッセージまで送信可能
    await reply(event.replyToken, replyTexts.slice(0, 5));
  }
}

// テキスト中に word が何回登場するかを数える(単純な部分文字列マッチ)
function countOccurrences(text, word) {
  if (!word) return 0;
  return text.split(word).length - 1;
}

// グループ/複数人トーク/個人トークを区別してユニークなIDを作る
function getSourceId(source) {
  if (!source) return null;
  if (source.type === 'group') return `group:${source.groupId}`;
  if (source.type === 'room') return `room:${source.roomId}`;
  if (source.type === 'user') return `user:${source.userId}`;
  return null;
}

// トークルームの種類に応じて、指定ユーザーの表示名を取得する。
// すでにグループ/複数人トークを退出済み・ブロック済みの場合など、
// プロフィールが取得できないケースもあるため null を返すことがある。
async function getDisplayName(source, userId) {
  try {
    if (source.type === 'group') {
      const profile = await client.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName;
    }
    if (source.type === 'room') {
      const profile = await client.getRoomMemberProfile(source.roomId, userId);
      return profile.displayName;
    }
    // 個人トークの場合(友だちである必要がある)
    const profile = await client.getProfile(userId);
    return profile.displayName;
  } catch (err) {
    console.error('プロフィールの取得に失敗しました:', err);
    return null;
  }
}

async function reply(replyToken, texts) {
  const messages = texts.map((text) => ({ type: 'text', text }));
  try {
    await client.replyMessage({ replyToken, messages });
  } catch (err) {
    console.error('返信の送信に失敗しました:', err);
  }
}

// ===================== サーバー起動 =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE word counter bot listening on port ${PORT}`);
  console.log(`カウント対象ワード: ${TARGET_WORDS.join(', ')}`);
});
