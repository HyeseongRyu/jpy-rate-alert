const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const STATE_FILE_PATH = "state.json";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  if (req.headers["x-telegram-bot-api-secret-token"] !== TELEGRAM_WEBHOOK_SECRET) {
    res.status(401).send("Unauthorized");
    return;
  }

  const text = req.body?.message?.text?.trim();
  const chatId = String(req.body?.message?.chat?.id ?? "");

  if (text && chatId === String(TELEGRAM_CHAT_ID)) {
    try {
      await handleCommand(text);
    } catch (err) {
      console.error(err);
      await sendTelegramMessage("⚠️ 명령 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.").catch(() => {});
    }
  }

  // Telegram이 재전송을 시도하지 않도록 항상 200을 반환한다.
  res.status(200).send("OK");
}

async function handleCommand(text) {
  if (text === "/threshold" || text === "/status") {
    const { state } = await readGithubState();
    const drop = state.dropThresholdPercent ?? 1;
    const rise = state.riseThresholdPercent ?? 1;
    await sendTelegramMessage(
      `⚙️ <b>현재 임계값</b>\n\n하락 알림: <b>${drop}%</b>\n상승 알림: <b>${rise}%</b>\n\n변경: /setdrop 값, /setrise 값`
    );
  } else if (text.startsWith("/setdrop")) {
    const value = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(value) || value <= 0) {
      await sendTelegramMessage("⚠️ 사용법: /setdrop 1.5 (0보다 큰 숫자)");
      return;
    }
    await updateGithubState((state) => {
      state.dropThresholdPercent = value;
    });
    await sendTelegramMessage(`✅ 하락 알림 임계값을 <b>${value}%</b>로 변경했습니다.`);
  } else if (text.startsWith("/setrise")) {
    const value = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(value) || value <= 0) {
      await sendTelegramMessage("⚠️ 사용법: /setrise 1.5 (0보다 큰 숫자)");
      return;
    }
    await updateGithubState((state) => {
      state.riseThresholdPercent = value;
    });
    await sendTelegramMessage(`✅ 상승 알림 임계값을 <b>${value}%</b>로 변경했습니다.`);
  } else if (text === "/help") {
    await sendTelegramMessage(
      `🤖 <b>명령어 안내</b>\n\n/threshold — 현재 임계값 확인\n/setdrop 값 — 하락 임계값 변경\n/setrise 값 — 상승 임계값 변경\n\n📊 알림 이력: https://jpy-rate-alert.vercel.app/history`
    );
  }
}

async function sendTelegramMessage(text) {
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

async function readGithubState() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${STATE_FILE_PATH}?ref=${GITHUB_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub 파일 조회 실패: ${res.status}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { state: JSON.parse(content), sha: data.sha };
}

async function updateGithubState(mutate) {
  const { state, sha } = await readGithubState();
  mutate(state);
  const content = Buffer.from(JSON.stringify(state, null, 2) + "\n", "utf-8").toString("base64");
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${STATE_FILE_PATH}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: "chore: update threshold via telegram command",
      content,
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub 파일 갱신 실패: ${res.status} ${body}`);
  }
}
