import { useState, useCallback } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import Modal from './Modal';

// Replaces window.confirm(), which cannot be relied on: browsers permanently suppress it
// for a page once the user ticks "prevent this page from creating additional dialogs", and
// block it outright inside cross-origin frames. In both cases it returns false silently, so
// the action it guards appears to do nothing at all.
//
// Usage:
//   const [confirm, confirmDialog] = useConfirm();
//   if (!(await confirm({ message: 'Delete this?' }))) return;
//   ... and render {confirmDialog} somewhere in the component.
export function useConfirm() {
  const [request, setRequest] = useState(null);

  const confirm = useCallback(opts => new Promise(resolve => {
    setRequest({
      title: 'Are you sure?',
      confirmLabel: 'Confirm',
      danger: true,
      ...(typeof opts === 'string' ? { message: opts } : opts),
      resolve,
    });
  }), []);

  const settle = answer => {
    request?.resolve(answer);
    setRequest(null);
  };

  const dialog = request ? (
    <Modal title={request.title} onClose={() => settle(false)} size="sm">
      <div className="space-y-5">
        <div className="flex gap-3">
          {request.danger && (
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: '#fef2f2' }}>
              <ExclamationTriangleIcon className="w-5 h-5" style={{ color: '#dc2626' }} />
            </div>
          )}
          <p className="text-sm text-gray-700 leading-relaxed">{request.message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => settle(false)}>Cancel</button>
          <button
            className={request.danger ? 'btn-primary' : 'btn-primary'}
            style={request.danger ? { background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(220,38,38,0.3)' } : undefined}
            onClick={() => settle(true)}
            autoFocus
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  ) : null;

  return [confirm, dialog];
}

export default useConfirm;
