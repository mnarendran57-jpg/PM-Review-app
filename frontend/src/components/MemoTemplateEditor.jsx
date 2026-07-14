import { useState, useEffect } from 'react';
import { PlusIcon, TrashIcon, CheckIcon, DocumentTextIcon, StarIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { memoTemplatesApi } from '../api';

const PLACEHOLDER_TOKENS = [
  'date', 'vendor_name', 'project_name', 'po_number', 'po_reference',
  'scope_of_work', 'total_price', 'change_order_price', 'original_po_amount',
  'new_total_amount', 'request_sentence', 'memo_type', 'to_name', 'from_name',
];

export default function MemoTemplateEditor() {
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = () => memoTemplatesApi.list().then(list => {
    setTemplates(list);
    if (list.length && !selectedId) {
      const def = list.find(t => t.is_default) || list[0];
      setSelectedId(String(def.id));
      setForm(def);
    }
  });
  useEffect(() => { load(); }, []);

  const selectTemplate = id => {
    setSelectedId(id);
    setForm(templates.find(t => String(t.id) === String(id)));
    setSaved(false);
  };

  const updateSection = (i, key, value) => {
    setForm(f => {
      const sections = [...f.sections];
      sections[i] = { ...sections[i], [key]: value };
      return { ...f, sections };
    });
  };

  const addSection = () => setForm(f => ({ ...f, sections: [...f.sections, { label: 'New Section', content: '' }] }));
  const removeSection = i => setForm(f => ({ ...f, sections: f.sections.filter((_, idx) => idx !== i) }));

  const save = async () => {
    setError('');
    try {
      const updated = await memoTemplatesApi.update(form.id, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      setTemplates(ts => ts.map(t => t.id === updated.id ? updated : t));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save template.');
    }
  };

  const saveAsNew = async () => {
    const name = prompt('Name for the new template:', `${form.name} (copy)`);
    if (!name) return;
    const created = await memoTemplatesApi.create({ ...form, name });
    setTemplates(ts => [...ts, created]);
    setSelectedId(String(created.id));
    setForm(created);
  };

  const setDefault = async () => {
    await memoTemplatesApi.setDefault(form.id);
    load();
  };

  if (!form) return null;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between flex-wrap gap-2"
        style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
        <div className="flex items-center gap-2">
          <DocumentTextIcon className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Proposal Memo Template</h2>
        </div>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-xs w-52" value={selectedId} onChange={e => selectTemplate(e.target.value)}>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>)}
          </select>
          <button className="btn-secondary px-2.5 py-1.5" title="Set as default" onClick={setDefault} disabled={form.is_default}>
            {form.is_default ? <StarSolidIcon className="w-4 h-4 text-amber-500" /> : <StarIcon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <p className="text-xs text-gray-500">
          This is the cover memo generated for every processed proposal (New Vendor or Change Order). Edit wording freely —
          use the tokens below anywhere in a section and they'll be filled in automatically when a memo is generated.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PLACEHOLDER_TOKENS.map(tok => (
            <code key={tok} className="text-[10px] px-2 py-1 rounded-md" style={{ background: '#f1f5f9', color: '#475569' }}>
              {`{{${tok}}}`}
            </code>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Template Name</label>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="label">Header Title (optional)</label>
            <input className="input" value={form.header_title} onChange={e => setForm(f => ({ ...f, header_title: e.target.value }))} placeholder="Leave blank to match standard letterhead" />
          </div>
        </div>
        <div>
          <label className="label">Letterhead (company name / address, one line each)</label>
          <textarea className="input" rows={4} value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))} />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="label mb-0">Memo Sections (rendered top to bottom)</label>
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={addSection}>
              <PlusIcon className="w-3.5 h-3.5" /> Add Section
            </button>
          </div>
          {form.sections.map((s, i) => (
            <div key={i} className="p-3 rounded-xl space-y-2" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
              <div className="flex items-center gap-2">
                <input
                  className="input py-1 text-sm flex-1"
                  value={s.label}
                  onChange={e => updateSection(i, 'label', e.target.value)}
                  placeholder="Section label (for your reference only)"
                />
                <label className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0">
                  <input type="checkbox" checked={!!s.divider_after} onChange={e => updateSection(i, 'divider_after', e.target.checked)} />
                  Divider after
                </label>
                <button type="button" className="btn-danger" onClick={() => removeSection(i)}>
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
              <textarea
                className="input text-sm"
                rows={2}
                value={s.content}
                onChange={e => updateSection(i, 'content', e.target.value)}
              />
            </div>
          ))}
        </div>

        {error && (
          <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={saveAsNew}>Save as New Template</button>
          <button
            className="btn-primary"
            onClick={save}
            style={saved ? { background: 'linear-gradient(135deg, #10b981, #059669)' } : {}}
          >
            {saved ? <span className="flex items-center gap-2"><CheckIcon className="w-4 h-4" /> Saved</span> : 'Save Template'}
          </button>
        </div>
      </div>
    </div>
  );
}
