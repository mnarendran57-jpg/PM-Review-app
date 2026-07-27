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

// Builds the instruction text. The report structure here is a sensible default; when the
// client supplies their own template this is the one place to reshape the output.
function buildPrompt({ projectName, frequency, periodLabel, visitDate, notes, images }) {
  const photoList = images.map((img, i) =>
    `  Photo ${i + 1}: ${img.caption ? img.caption : '(no caption provided)'}`
  ).join('\n');

  return `You are a senior MEP construction project manager writing a site progress report for
the owner and project team, based on photographs taken during a site visit. Write for a
reader who is not on site — clear, professional, plain English, no jargon without explanation.

Project: ${projectName || 'Not specified'}
Visit frequency: ${frequency || 'Not specified'}
Reporting period: ${periodLabel || 'Not specified'}${visitDate ? `\nVisit date: ${visitDate}` : ''}
${notes ? `\nPM's notes for this visit:\n${notes}\n` : ''}
The ${images.length} photographs are provided in order. Each has a caption from the PM:
${photoList}

Study every photograph. Base your observations ONLY on what is visible in the images and the
captions/notes provided — do not invent progress, measurements, or trades you cannot see.
Where something is unclear from a photo, say so rather than guessing.

Return ONLY valid JSON in this exact shape:

{
  "title": "<short report title>",
  "executiveSummary": "<3-5 sentences: overall state of the work this period, general sense of progress and anything the team should know>",
  "workObserved": [
    { "area": "<trade or area, e.g. 'HVAC — Level 2' or 'Electrical rough-in'>",
      "observation": "<what the photos show is happening or complete here>" }
  ],
  "photoLog": [
    { "photo": <1-based photo number>,
      "caption": "<echo the PM's caption, or a short one if none was given>",
      "observation": "<what you specifically see in this photo and what it indicates about progress>" }
  ],
  "issuesAndConcerns": [ "<anything visible that warrants attention: safety, incomplete work, damage, sequencing, housekeeping — or leave empty if none>" ],
  "recommendedNextSteps": [ "<practical next actions for the team based on what the photos show>" ]
}

Rules:
- Include one entry in "photoLog" for every photo, in order.
- "workObserved" should group the photos into meaningful areas/trades — not one entry per photo.
- Keep it grounded and specific. If the photos don't support a claim, don't make it.
- Plain English for a non-construction reader.`;
}

async function callClaude(content) {
  return client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content }],
  });
}

// Single Claude vision call: all site photos (interleaved with a label so the model knows
// which caption belongs to which image), then the instruction. images: [{ buffer, mediaType,
// caption, fileName }].
async function analyzeProgress({ images, projectName, frequency, periodLabel, visitDate, notes }) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}${img.caption ? ` — ${img.caption}` : ''}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.buffer.toString('base64') },
    });
  });
  content.push({ type: 'text', text: buildPrompt({ projectName, frequency, periodLabel, visitDate, notes, images }) });

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
  return normalizeReport(parsed);
}

function normalizeReport(parsed) {
  return {
    title: parsed.title || 'Site Progress Report',
    executiveSummary: parsed.executiveSummary || '',
    workObserved: Array.isArray(parsed.workObserved)
      ? parsed.workObserved.filter(w => w && (w.area || w.observation)).map(w => ({ area: w.area || '', observation: w.observation || '' }))
      : [],
    photoLog: Array.isArray(parsed.photoLog)
      ? parsed.photoLog.map(p => ({ photo: p.photo ?? null, caption: p.caption || '', observation: p.observation || '' }))
      : [],
    issuesAndConcerns: Array.isArray(parsed.issuesAndConcerns) ? parsed.issuesAndConcerns.filter(Boolean) : [],
    recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps) ? parsed.recommendedNextSteps.filter(Boolean) : [],
  };
}

function renderMarkdown({ report, header }) {
  const lines = [];
  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`**Project:** ${header.projectName || 'Not specified'}  `);
  if (header.frequency) lines.push(`**Visit frequency:** ${header.frequency}  `);
  if (header.periodLabel) lines.push(`**Reporting period:** ${header.periodLabel}  `);
  if (header.visitDate) lines.push(`**Visit date:** ${header.visitDate}  `);
  lines.push(`**Photos reviewed:** ${header.imageCount}  `);
  lines.push('');

  if (report.executiveSummary) {
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(report.executiveSummary);
    lines.push('');
  }

  if (report.workObserved.length) {
    lines.push('## Work Observed This Period');
    lines.push('');
    for (const w of report.workObserved) {
      lines.push(`- **${w.area || 'General'}** — ${w.observation}`);
    }
    lines.push('');
  }

  if (report.issuesAndConcerns.length) {
    lines.push('## Issues & Concerns');
    lines.push('');
    for (const i of report.issuesAndConcerns) lines.push(`- ${i}`);
    lines.push('');
  }

  if (report.recommendedNextSteps.length) {
    lines.push('## Recommended Next Steps');
    lines.push('');
    for (const s of report.recommendedNextSteps) lines.push(`- ${s}`);
    lines.push('');
  }

  if (report.photoLog.length) {
    lines.push('## Photo Log');
    lines.push('');
    for (const p of report.photoLog) {
      lines.push(`**Photo ${p.photo ?? ''}${p.caption ? ` — ${p.caption}` : ''}**  `);
      lines.push(p.observation || '');
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { analyzeProgress, renderMarkdown };
