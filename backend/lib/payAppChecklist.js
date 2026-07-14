const { money } = require('./payAppChecks');

// Builds a deterministic (no AI call) checklist of items the PM should physically verify
// on site: anything billed as NEW this period (completed work, stored materials, or a new
// change order). Pure arithmetic over already-extracted data — sorted by dollar impact so
// the PM sees the highest-stakes items first.
function buildSiteVerificationChecklist(current, previous) {
  const items = [];
  const prevByItem = new Map((previous?.lineItems || []).map(li => [String(li.itemNo), li]));

  for (const li of current?.lineItems || []) {
    const thisPeriod = Number(li.e) || 0;
    const stored = Number(li.f) || 0;
    const amount = thisPeriod + stored;
    if (amount <= 0) continue;

    const isNewItem = !!previous && !prevByItem.has(String(li.itemNo));
    const parts = [];
    if (thisPeriod) parts.push(`${money(thisPeriod)} of newly completed work`);
    if (stored) parts.push(`${money(stored)} of stored materials`);

    items.push({
      itemNo: li.itemNo,
      description: li.description || `Item ${li.itemNo}`,
      amount,
      isNew: isNewItem,
      detail: `${isNewItem ? 'New line item this period. ' : ''}Claims ${parts.join(' and ')} — confirm actual progress/quantities on site before approving.`
    });
  }

  if (current?.coBreakdown?.length) {
    const prevCoNumbers = new Set((previous?.coBreakdown || []).map(c => String(c.coNumber)));
    for (const co of current.coBreakdown) {
      if (prevCoNumbers.has(String(co.coNumber))) continue;
      items.push({
        itemNo: co.coNumber,
        description: `Change Order ${co.coNumber}`,
        amount: Math.abs(Number(co.amount) || 0),
        isNew: true,
        detail: `New change order for ${money(co.amount)} — verify supporting documentation and approval before including it in Line 2.`
      });
    }
  }

  items.sort((a, b) => b.amount - a.amount);
  return items;
}

module.exports = { buildSiteVerificationChecklist };
