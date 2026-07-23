/**
 * Sdílený Resend e-mail helper pro workery (cron-alerts, flex-import).
 *
 * sendResendEmail — obecné odeslání (alerty).
 * sendFailureEmail — notifikace o selhání workeru. Bez nastavených
 * RESEND_API_KEY / EMAIL_FROM / EMAIL_TO tiše vrátí ok:false — selhání
 * notifikace nesmí shodit samotný worker.
 */

export async function sendResendEmail(env, subject, html, text) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY není nastavený (secret)" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.EMAIL_TO],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${errText}` };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

export async function sendFailureEmail(env, workerName, err) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.EMAIL_TO) {
    return { ok: false, error: "RESEND_API_KEY/EMAIL_FROM/EMAIL_TO nenastaveno" };
  }
  const msg = String(err?.stack || err?.message || err);
  const esc = msg.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  try {
    return await sendResendEmail(
      env,
      `[Akcie tracker] ⚠️ ${workerName} selhal`,
      `<p>Worker <strong>${workerName}</strong> selhal:</p><pre style="background:#f6f6f4;padding:12px;border-radius:6px;">${esc}</pre>`,
      `Worker ${workerName} selhal:\n\n${msg}`,
    );
  } catch (e) {
    // Notifikace nesmí shodit worker
    return { ok: false, error: String(e.message || e) };
  }
}
