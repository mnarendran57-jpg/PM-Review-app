import { useBudget } from "../context/BudgetContext";
import Card from "../components/Card";
import StatusBanner from "../components/StatusBanner";
import {
  sumMonthlyIncome,
  sumExpenses,
  sumDebtPayments,
  sumMiscSpending,
  largestCategory,
  getBudgetStatus,
  formatCurrency,
} from "../utils/calculations";

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-line py-3.5 last:border-none">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  );
}

export default function Summary() {
  const { state } = useBudget();
  const { expenses, debts, savingsGoal, currentSavings, miscCap } = state;

  const monthlyIncome = sumMonthlyIncome(state.income);
  const totalExpenses = sumExpenses(expenses);
  const debtPayments = sumDebtPayments(debts);
  const miscSpent = sumMiscSpending(expenses);
  const top = largestCategory(expenses);
  const { status, remaining } = getBudgetStatus(monthlyIncome, totalExpenses + debtPayments);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Monthly Summary</h1>
        <p className="mt-1 text-sm text-ink-faint">A simple overview of where things stand.</p>
      </div>

      <StatusBanner status={status} remaining={remaining} />

      <Card padding="p-6">
        <SummaryRow label="Income" value={formatCurrency(monthlyIncome)} />
        <SummaryRow label="Expenses" value={formatCurrency(totalExpenses)} />
        <SummaryRow label="Debt payments" value={formatCurrency(debtPayments)} />
        <SummaryRow label="Savings goal" value={formatCurrency(savingsGoal)} />
        <SummaryRow label="Current savings" value={formatCurrency(currentSavings)} />
        <SummaryRow label="Remaining money" value={formatCurrency(remaining)} />
        <SummaryRow
          label="Largest expense category"
          value={top ? `${top.category} (${formatCurrency(top.total)})` : "—"}
        />
        <SummaryRow
          label="Miscellaneous spending"
          value={`${formatCurrency(miscSpent)} / ${formatCurrency(miscCap)}`}
        />
      </Card>
    </div>
  );
}
