const GITHUB_REPO = process.env.GITHUB_REPO || "HyeseongRyu/jpy-rate-alert";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const ALERT_LABELS = { drop: "🔻 하락", rise: "🔺 상승", summary: "📅 요약", error: "⚠️ 오류" };

// 환율은 변동폭에 비해 절대값이 커서 y축이 0부터 시작하면 변동이 안 보이므로,
// 데이터 범위에 여백만 살짝 두고 y축을 맞춘다.
function computeYRange(data) {
  if (data.length === 0) return {};
  const min = Math.min(...data);
  const max = Math.max(...data);
  const padding = Math.max((max - min) * 0.15, min * 0.003);
  return { min: min - padding, max: max + padding };
}

export default async function handler(req, res) {
  let history = { ratePoints: [], dailyHistory: [], alerts: [] };
  try {
    const raw = await fetch(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/history.json`
    );
    if (raw.ok) {
      history = await raw.json();
    }
  } catch (err) {
    console.error("history.json 조회 실패:", err.message);
  }

  const dailyHistory = (history.dailyHistory ?? []).slice(-30);
  const alerts = (history.alerts ?? []).slice(-50).reverse();

  const closes = dailyHistory.map((d) => d.close);
  const yRange = computeYRange(closes);

  const chartConfig = {
    type: "line",
    data: {
      labels: dailyHistory.map((d) => d.date.slice(5)),
      datasets: [
        {
          label: "100엔당 원화(종가)",
          data: closes,
          borderColor: "#2563eb",
          backgroundColor: "#2563eb",
          pointRadius: 0,
          fill: false,
          tension: 0.2,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: yRange },
    },
  };
  const chartUrl = `https://quickchart.io/chart?width=700&height=300&c=${encodeURIComponent(
    JSON.stringify(chartConfig)
  )}`;

  const rows = alerts
    .map((a) => {
      const time = new Date(a.t).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      const detail =
        a.type === "drop" || a.type === "rise"
          ? `${a.rate100?.toFixed(2)}원 (${a.changePercent?.toFixed(2)}%)`
          : a.type === "summary"
          ? `${a.rate100?.toFixed(2)}원`
          : a.type === "error"
          ? escapeHtml(a.message ?? "")
          : "";
      return `<tr><td>${time}</td><td>${ALERT_LABELS[a.type] ?? a.type}</td><td>${detail}</td></tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>엔화 환율 알람 이력</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 40px auto; padding: 0 16px; color: #1f2937; }
  h1 { font-size: 1.4rem; }
  img { max-width: 100%; border-radius: 8px; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; }
  th { color: #6b7280; font-weight: 600; }
</style>
</head>
<body>
  <h1>🇯🇵 엔화 환율 알람 이력</h1>
  ${dailyHistory.length ? `<img src="${chartUrl}" alt="최근 30일 환율 추이" />` : "<p>아직 일일 요약 데이터가 없습니다.</p>"}
  <table>
    <thead><tr><th>시각</th><th>구분</th><th>내용</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">아직 기록된 알림이 없습니다.</td></tr>'}</tbody>
  </table>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
