const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      'The progress report could not be read back as valid data — try generating it again. ' +
      `(${err.message})`
    );
  }
}

// Builds the instruction text. Output is deliberately short: the report template is a
// header block, a bulleted "Progress" list, and a captioned photo grid — so the model's
// only job is to write the Progress bullets from what the photos and captions show.
function buildPrompt({ projectName, contractor, periodLabel, visitDate, notes, images }) {
  const photoList = images.map((img, i) =>
    `  Photo ${i + 1}: ${img.caption ? img.caption : '(no caption provided)'}`
  ).join('\n');

  return `You are an MEP construction project manager writing the "Progress" section of a
site progress report, based on photographs taken during a site visit.

Project: ${projectName || 'Not specified'}${contractor ? `\nContractor: ${contractor}` : ''}${visitDate ? `\nDate: ${visitDate}` : ''}${periodLabel ? `\nPeriod: ${periodLabel}` : ''}
${notes ? `\nPM's notes for this visit:\n${notes}\n` : ''}
The ${images.length} photographs are provided in order, each with a caption from the PM:
${photoList}

Write the Progress section as a short list of factual, plain-English observations — the
kind a PM notes on a site walk. Cover what work is underway or complete, and flag anything
visible that warrants attention (uncovered drains, incomplete or damaged work, safety,
housekeeping). Base every statement ONLY on what the photos and captions show — do not
invent progress, quantities, or trades you cannot see.

Style: each bullet is one concise sentence. Aim for 3-7 bullets total. No headings, no
per-photo log, no recommendations section — just the observations. Example of the tone:
  "Irrigation work has begun, along with associated plumbing works."
  "Several grates have not been covered, which could cause dirt to enter the storm sewers."

Return ONLY valid JSON in this exact shape:
{
  "title": "<project name> Progress Report",
  "progress": [ "<one observation sentence>", "..." ]
}`;
}

async function callClaude(content) {
  return client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content }],
  });
}

// Single Claude vision call: all site photos (interleaved with a label so the model knows
// which caption belongs to which image), then the instruction. images: [{ buffer, mediaType,
// caption, fileName }].
async function analyzeProgress({ images, projectName, contractor, periodLabel, visitDate, notes }) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}${img.caption ? ` — ${img.caption}` : ''}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.buffer.toString('base64') },
    });
  });
  content.push({ type: 'text', text: buildPrompt({ projectName, contractor, periodLabel, visitDate, notes, images }) });

  let response;
  try {
    response = await callClaude(content);
  } catch (err) {
    if (err.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 20000));
      response = await callClaude(content);
    } else {
      throw err;
    }
  }

  if (response.stop_reason === 'max_tokens') {
    throw new Error('The report ran long and was cut off — try again with fewer photos or shorter captions.');
  }

  const parsed = safeJsonFromText(response.content[0].text);
  if (response.usage) {
    console.log(`[progress report] images=${images.length} in=${response.usage.input_tokens} out=${response.usage.output_tokens} tokens`);
  }
  return normalizeReport(parsed, projectName);
}

function normalizeReport(parsed, projectName) {
  return {
    title: parsed.title || `${projectName || 'Site'} Progress Report`,
    progress: Array.isArray(parsed.progress) ? parsed.progress.filter(Boolean).map(String) : [],
  };
}

// The markdown mirrors the template (header block, Progress bullets, captioned Site
// Pictures list). The PDF is the primary deliverable; this stays as a text fallback.
function renderMarkdown({ report, header, photos }) {
  const lines = [];
  const num = header.reportNumber != null ? `-${header.reportNumber}` : '';
  lines.push(`# ${header.projectName || 'Project'} Progress Report${num}`);
  lines.push('');
  lines.push(`**Date:** ${header.visitDate || 'Not specified'}   **Time:** ${header.visitTime || '—'}   **Weather:** ${header.weather || '—'}  `);
  lines.push(`**Submitted By:** ${header.submittedBy || '—'}  `);
  lines.push(`**Project:** ${header.projectName || '—'}  `);
  lines.push(`**Contractor:** ${header.contractor || '—'}  `);
  lines.push('');
  lines.push('## Progress');
  lines.push('');
  if (report.progress.length === 0) {
    lines.push('_No observations recorded._');
  } else {
    for (const p of report.progress) lines.push(`- ${p}`);
  }
  lines.push('');
  lines.push('## Site Pictures');
  lines.push('');
  (photos || []).forEach((p, i) => {
    lines.push(`${i + 1}. ${p.caption || '(no caption)'}`);
  });
  return lines.join('\n');
}

module.exports = { analyzeProgress, renderMarkdown };
