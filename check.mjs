import { readFile, writeFile } from "node:fs/promises";

const STATE_PATH = new URL("./state.json", import.meta.url);
const DROP_THRESHOLD_PERCENT = 1;
const RATE_API_URL = "https://api.exchangerate-api.com/v4/latest/JPY";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastRate100: null, lastCheckedAt: null };
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function fetchRate100() {
  const res = await fetch(RATE_API_URL);
  if (!res.ok) {
    throw new Error(`환율 API 응답 실패: ${res.status}`);
  }
  const data = await res.json();
  const krwPerJpy = data.rates?.KRW;
  if (typeof krwPerJpy !== "number") {
    throw new Error("응답에서 KRW 환율을 찾을 수 없습니다.");
  }
  return { rate100: krwPerJpy * 100, apiDate: data.date };
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 설정되지 않았습니다.");
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`텔레그램 전송 실패: ${res.status} ${body}`);
  }
}

function formatKst(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function main() {
  const state = await readState();
  const { rate100, apiDate } = await fetchRate100();
  const now = new Date();

  console.log(`[${formatKst(now)}] 100엔당 ${rate100.toFixed(2)}원 (API 기준일: ${apiDate})`);

  if (state.lastRate100 != null) {
    const changePercent = ((rate100 - state.lastRate100) / state.lastRate100) * 100;
    console.log(`직전 대비 변동: ${changePercent.toFixed(3)}%`);

    if (changePercent <= -DROP_THRESHOLD_PERCENT) {
      const message =
        `🔻 <b>엔화 환율 하락 알림</b>\n\n` +
        `100엔당 <b>${rate100.toFixed(2)}원</b>\n` +
        `직전 확인(${formatKst(new Date(state.lastCheckedAt))}) 대비 <b>${changePercent.toFixed(2)}%</b> 하락\n` +
        `이전: ${state.lastRate100.toFixed(2)}원 → 현재: ${rate100.toFixed(2)}원\n\n` +
        `${formatKst(now)} 기준`;

      await sendTelegramMessage(message);
      console.log("텔레그램 알림 전송 완료");
    }
  } else {
    console.log("첫 실행: 기준값을 저장합니다.");
  }

  await writeState({ lastRate100: rate100, lastCheckedAt: now.toISOString() });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
