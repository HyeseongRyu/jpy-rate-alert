import { readFile, writeFile } from "node:fs/promises";

const STATE_PATH = new URL("./state.json", import.meta.url);
const HISTORY_PATH = new URL("./history.json", import.meta.url);
const RATE_API_URL = "https://api.exchangerate-api.com/v4/latest/JPY";
const FETCH_RETRY_COUNT = 2;
const FETCH_RETRY_DELAY_MS = 5000;
const RATE_POINTS_LIMIT = 96; // 30분 간격 기준 약 48시간
const DAILY_HISTORY_LIMIT = 90;
const ALERTS_LIMIT = 100;

const DEFAULT_DROP_THRESHOLD_PERCENT = process.env.DROP_THRESHOLD_PERCENT
  ? Number(process.env.DROP_THRESHOLD_PERCENT)
  : 1;
const DEFAULT_RISE_THRESHOLD_PERCENT = process.env.RISE_THRESHOLD_PERCENT
  ? Number(process.env.RISE_THRESHOLD_PERCENT)
  : 1;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      lastRate100: null,
      lastCheckedAt: null,
      peakRate100: null,
      troughRate100: null,
      dailyDate: null,
      dailyHigh100: null,
      dailyLow100: null,
      dropThresholdPercent: null,
      riseThresholdPercent: null,
    };
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function readHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { ratePoints: [], dailyHistory: [], alerts: [] };
  }
}

async function writeHistory(history) {
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEffectiveThresholds(state) {
  return {
    drop: state.dropThresholdPercent ?? DEFAULT_DROP_THRESHOLD_PERCENT,
    rise: state.riseThresholdPercent ?? DEFAULT_RISE_THRESHOLD_PERCENT,
  };
}

async function fetchRate100() {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_RETRY_COUNT + 1; attempt++) {
    try {
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
    } catch (err) {
      lastError = err;
      console.error(`환율 조회 실패 (${attempt}/${FETCH_RETRY_COUNT + 1}회): ${err.message}`);
      if (attempt <= FETCH_RETRY_COUNT) {
        await sleep(FETCH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
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

async function sendTelegramPhoto(photoUrl, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 설정되지 않았습니다.");
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, photo: photoUrl, caption, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`텔레그램 사진 전송 실패: ${res.status} ${body}`);
  }
}

function buildLineChartConfig(labels, data, label) {
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          fill: false,
          borderColor: "#2563eb",
          backgroundColor: "#2563eb",
          pointRadius: 0,
          tension: 0.2,
        },
      ],
    },
    options: { plugins: { legend: { display: false } } },
  };
}

async function createChartUrl(config) {
  const res = await fetch("https://quickchart.io/chart/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chart: config, width: 500, height: 300, backgroundColor: "white" }),
  });
  if (!res.ok) {
    throw new Error(`차트 생성 실패: ${res.status}`);
  }
  const data = await res.json();
  return data.url;
}

// 차트 첨부를 시도하고, 실패하면 텍스트 메시지로만 전송한다.
async function sendAlertWithChart(text, labels, data, chartLabel) {
  try {
    const chartUrl = await createChartUrl(buildLineChartConfig(labels, data, chartLabel));
    await sendTelegramPhoto(chartUrl, text);
  } catch (err) {
    console.error("차트 첨부 실패, 텍스트만 전송:", err.message);
    await sendTelegramMessage(text);
  }
}

function formatKst(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function kstTimeLabel(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function kstDateString(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
}

function logAlert(history, entry) {
  history.alerts = [...history.alerts, { t: new Date().toISOString(), ...entry }].slice(-ALERTS_LIMIT);
}

async function main() {
  const state = await readState();
  const history = await readHistory();
  const now = new Date();
  const todayKst = kstDateString(now);

  let rate100, apiDate;
  try {
    ({ rate100, apiDate } = await fetchRate100());
  } catch (err) {
    console.error("환율 조회 최종 실패:", err.message);
    logAlert(history, { type: "error", message: err.message });
    try {
      await sendTelegramMessage(
        `⚠️ <b>엔화 환율 봇 오류</b>\n\n환율 조회에 ${FETCH_RETRY_COUNT + 1}회 연속 실패했습니다.\n에러: ${err.message}\n\n${formatKst(now)} 기준`
      );
    } catch (notifyErr) {
      console.error("실패 알림 전송도 실패:", notifyErr.message);
    }
    await writeState(state);
    await writeHistory(history);
    process.exit(1);
  }

  console.log(`[${formatKst(now)}] 100엔당 ${rate100.toFixed(2)}원 (API 기준일: ${apiDate})`);

  history.ratePoints = [...history.ratePoints, { t: now.toISOString(), r: rate100 }].slice(
    -RATE_POINTS_LIMIT
  );

  if (state.dailyDate && state.dailyDate !== todayKst) {
    const summary =
      `📅 <b>어제(${state.dailyDate}) 엔화 환율 요약</b>\n\n` +
      `최고: ${state.dailyHigh100.toFixed(2)}원\n` +
      `최저: ${state.dailyLow100.toFixed(2)}원\n` +
      `오늘 현재: ${rate100.toFixed(2)}원\n\n` +
      `${formatKst(now)} 기준`;

    history.dailyHistory = [
      ...history.dailyHistory,
      {
        date: state.dailyDate,
        high: state.dailyHigh100,
        low: state.dailyLow100,
        close: state.lastRate100 ?? rate100,
      },
    ].slice(-DAILY_HISTORY_LIMIT);
    logAlert(history, { type: "summary", rate100 });

    try {
      const recentDays = history.dailyHistory.slice(-14);
      await sendAlertWithChart(
        summary,
        recentDays.map((d) => d.date.slice(5)),
        recentDays.map((d) => d.close),
        "100엔당 원화(종가)"
      );
      console.log("일일 요약 알림 전송 완료");
    } catch (err) {
      console.error("일일 요약 전송 실패:", err.message);
    }
    state.dailyHigh100 = rate100;
    state.dailyLow100 = rate100;
  } else {
    state.dailyHigh100 = state.dailyHigh100 != null ? Math.max(state.dailyHigh100, rate100) : rate100;
    state.dailyLow100 = state.dailyLow100 != null ? Math.min(state.dailyLow100, rate100) : rate100;
  }
  state.dailyDate = todayKst;

  if (state.peakRate100 == null || state.troughRate100 == null) {
    console.log("첫 실행: 기준값을 저장합니다.");
    state.peakRate100 = rate100;
    state.troughRate100 = rate100;
  } else {
    const { drop: dropThresholdPercent, rise: riseThresholdPercent } = getEffectiveThresholds(state);
    const peak = Math.max(state.peakRate100, rate100);
    const trough = Math.min(state.troughRate100, rate100);
    const dropFromPeakPercent = ((rate100 - peak) / peak) * 100;
    const riseFromTroughPercent = ((rate100 - trough) / trough) * 100;

    if (state.lastRate100 != null) {
      const stepChangePercent = ((rate100 - state.lastRate100) / state.lastRate100) * 100;
      console.log(`직전 대비 변동: ${stepChangePercent.toFixed(3)}%`);
    }
    console.log(
      `추적 고점 대비: ${dropFromPeakPercent.toFixed(3)}% / 추적 저점 대비: ${riseFromTroughPercent.toFixed(3)}%`
    );

    const recentPoints = history.ratePoints.slice(-24);
    const recentLabels = recentPoints.map((p) => kstTimeLabel(new Date(p.t)));
    const recentRates = recentPoints.map((p) => p.r);

    if (dropFromPeakPercent <= -dropThresholdPercent) {
      const message =
        `🔻 <b>엔화 환율 하락 알림</b>\n\n` +
        `100엔당 <b>${rate100.toFixed(2)}원</b>\n` +
        `추적 고점(${peak.toFixed(2)}원) 대비 <b>${dropFromPeakPercent.toFixed(2)}%</b> 하락\n\n` +
        `${formatKst(now)} 기준`;
      logAlert(history, { type: "drop", rate100, changePercent: dropFromPeakPercent });
      await sendAlertWithChart(message, recentLabels, recentRates, "100엔당 원화");
      console.log("하락 알림 전송 완료");
      state.peakRate100 = rate100;
      state.troughRate100 = rate100;
    } else if (riseFromTroughPercent >= riseThresholdPercent) {
      const message =
        `🔺 <b>엔화 환율 상승 알림</b>\n\n` +
        `100엔당 <b>${rate100.toFixed(2)}원</b>\n` +
        `추적 저점(${trough.toFixed(2)}원) 대비 <b>${riseFromTroughPercent.toFixed(2)}%</b> 상승\n\n` +
        `${formatKst(now)} 기준`;
      logAlert(history, { type: "rise", rate100, changePercent: riseFromTroughPercent });
      await sendAlertWithChart(message, recentLabels, recentRates, "100엔당 원화");
      console.log("상승 알림 전송 완료");
      state.peakRate100 = rate100;
      state.troughRate100 = rate100;
    } else {
      state.peakRate100 = peak;
      state.troughRate100 = trough;
    }
  }

  state.lastRate100 = rate100;
  state.lastCheckedAt = now.toISOString();
  await writeState(state);
  await writeHistory(history);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
