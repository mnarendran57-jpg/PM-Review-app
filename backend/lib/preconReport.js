function renderMarkdown({ projectName, reviewFocus, fileNames, analysis }) {
  const lines = [];
  lines.push(`# Pre-Construction Document Review${projectName ? ` — ${projectName}` : ''}`);
  lines.push('');
  lines.push(`**Documents reviewed:** ${fileNames.join(', ')}`);
  if (reviewFocus) lines.push(`**Review focus requested:** ${reviewFocus}`);
  lines.push('');

  if (analysis.insufficientInfo) {
    lines.push('> ⚠️ **The uploaded documents do not contain enough information for a complete review.**');
    lines.push(`> ${analysis.insufficientInfoNote || 'Additional documents are needed.'}`);
    lines.push('');
  }

  lines.push('## Project / Document Summary');
  lines.push('');
  lines.push(analysis.documentSummary || '_Not available._');
  lines.push('');

  const bulletSection = (title, items) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (!items || items.length === 0) {
      lines.push('_None identified._');
    } else {
      for (const item of items) {
        if (typeof item === 'string') {
          lines.push(`- ${item}`);
        } else {
          lines.push(`- [${item.basis === 'confirmed' ? 'Confirmed' : 'Assumption'}] ${item.text}`);
        }
      }
    }
    lines.push('');
  };

  bulletSection('Potential Risks', analysis.risks);
  bulletSection('High-Cost Items', analysis.highCostItems);
  bulletSection('Potential Change Order Areas', analysis.changeOrderAreas);
  bulletSection('Missing or Unclear Information', analysis.missingInfo);
  bulletSection('Recommended PM Action Items', analysis.actionItems);

  return lines.join('\n');
}

module.exports = { renderMarkdown };
