import { useEffect, useRef, useState } from 'react';
import { payAppReviewApi } from '../api';

// The findings report, rendered by the backend and shown in an isolated frame.
//
// An iframe rather than injected markup, deliberately. The report is one document with its own
// typography and its own print rules — it is the thing that gets forwarded to a contractor — and
// dropping it into the app's stylesheet would let Tailwind's resets rewrite it. Isolation also
// means the printed copy is the report alone, without the surrounding application.
//
// The frame grows to fit its content instead of scrolling, so the report reads as part of the
// page rather than as a window onto a separate one.
export default function PayAppFindingsReport({ reviewId }) {
  const [html, setHtml] = useState(null);
  const [error, setError] = useState(null);
  const [height, setHeight] = useState(600);
  const frame = useRef(null);

  useEffect(() => {
    let live = true;
    setHtml(null);
    setError(null);
    payAppReviewApi.reportHtml(reviewId)
      .then(doc => { if (live) setHtml(doc); })
      .catch(err => {
        if (live) setError(err.friendlyMessage || err.response?.data?.error || 'The report could not be loaded.');
      });
    return () => { live = false; };
  }, [reviewId]);

  // Content height is only knowable once the document has laid out, and it changes when the
  // frame is resized, so it is measured on load and then watched.
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (doc?.body) setHeight(doc.body.scrollHeight + 8);
  };

  useEffect(() => {
    if (!html) return undefined;
    const win = frame.current?.contentWindow;
    if (!win) return undefined;
    win.addEventListener('resize', fit);
    const timer = setInterval(fit, 400);
    return () => { win.removeEventListener('resize', fit); clearInterval(timer); };
  }, [html]);

  const print = () => frame.current?.contentWindow?.print();

  if (error) {
    return (
      <div className="card px-5 py-6">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }
  if (!html) {
    return (
      <div className="card px-5 py-12 text-center">
        <p className="text-sm text-gray-400">Preparing the report…</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-end border-b border-gray-100 px-3 py-1.5">
        <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={print}>
          Print
        </button>
      </div>
      <iframe
        ref={frame}
        title="Pay application review"
        srcDoc={html}
        onLoad={fit}
        style={{ width: '100%', height, border: 0, display: 'block' }}
      />
    </div>
  );
}
