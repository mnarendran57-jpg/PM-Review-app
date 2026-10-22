import { Link } from 'react-router-dom';
import { ClockIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import { usePlanFeatures } from '../hooks/usePlanFeatures';

// The free trial, said where everyone can see it: how long is left while it runs, and — once it
// has ended — that their work is all still here and what to do to carry on. Nothing is shown for a
// company on a subscription, or one from before sign-up.
export default function TrialBanner() {
  const { subscription } = usePlanFeatures();
  if (!subscription?.status) return null;

  if (subscription.status === 'trial') {
    const days = subscription.daysLeft;
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px]"
        style={{ background: days <= 3 ? '#fff7ed' : '#eff6ff', border: `1px solid ${days <= 3 ? '#fed7aa' : '#dbeafe'}`, color: days <= 3 ? '#9a3412' : '#1d4ed8' }}>
        <ClockIcon className="w-4 h-4 flex-shrink-0" />
        <span><span className="font-semibold">Free trial:</span> {days} day{days === 1 ? '' : 's'} left.</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12px]"
      style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
      <LockClosedIcon className="w-4 h-4 flex-shrink-0" />
      <span>
        <span className="font-semibold">{subscription.status === 'trial-ended' ? 'Your free trial has ended.' : 'Your subscription is not active.'}</span>{' '}
        Everything you've done is still here to view. To start new reviews, <Link to="/contact" className="underline font-semibold">contact us to subscribe</Link>.
      </span>
    </div>
  );
}
