import { Link } from "react-router-dom";
import {
  Wallet,
  Receipt,
  Lock,
  Shuffle,
  CreditCard,
  Scale,
  PiggyBank,
  ShoppingBag,
} from "lucide-react";
import { useBudget } from "../context/BudgetContext";
import StatCard from "../components/StatCard";
import StatusBanner from "../components/StatusBanner";
import Card from "../components/Card";
import ProgressBar from "../components/ProgressBar";
import {
  sumMonthlyIncome,
  sumExpenses,
  sumExpensesByType,
  sumDebtPayments,
  sumMiscSpending,
  miscUsageRatio,
  miscWarningLevel,
  getBudgetStatus,
  formatCurrency,
} from "../utils/calculations";

const MISC_MESSAGES = {
  gentle: "You're getting close to your miscellaneous spending limit.",
  strong: "You're almost at your miscellaneous spending limit.",
  over: null,
};

const MISC_TONE = {
  none: "brand",
  gentle: "warn",
  strong: "warn",
  over: "bad",
};

export default function Dashboard() {
  const { state } = useBudget();
  const { expenses, debts, miscCap, savingsGoal, currentSavings } = state;

  const monthlyIncome = sumMonthlyIncome(state.income);
  const totalExpenses = sumExpenses(expenses);
  const fixedExpenses = sumExpensesByType(expenses, "fixed");
  const variableExpenses = sumExpensesByType(expenses, "variable");
  const debtPayments = sumDebtPayments(debts);
  const miscSpent = sumMiscSpending(expenses);
  const totalOutgoing = totalExpenses + debtPayments;
  const { status, remaining } = getBudgetStatus(monthlyIncome, totalOutgoing);
  const miscLevel = miscWarningLevel(miscSpent, miscCap);
  const miscOver = Math.max(miscSpent - miscCap, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-faint">
          Here's where your money stands this month.
        </p>
      </div>

      <StatusBanner status={status} remaining={remaining} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Monthly income" value={formatCurrency(monthlyIncome)} icon={Wallet} />
        <StatCard
          label="Total expenses"
          value={formatCurrency(totalExpenses)}
          icon={Receipt}
          tone="warn"
        />
        <StatCard
          label="Remaining balance"
          value={formatCurrency(remaining)}
          icon={Scale}
          tone={remaining < 0 ? "bad" : "good"}
        />
        <StatCard label="Fixed expenses" value={formatCurrency(fixedExpenses)} icon={Lock} />
        <StatCard label="Variable expenses" value={formatCurrency(variableExpenses)} icon={Shuffle} />
        <StatCard
          label="Monthly debt payments"
          value={formatCurrency(debtPayments)}
          icon={CreditCard}
        />
        <StatCard
          label="Savings"
          value={formatCurrency(currentSavings)}
          subtext={savingsGoal > 0 ? `Goal: ${formatCurrency(savingsGoal)} / month` : undefined}
          icon={PiggyBank}
          tone="good"
        />
      </div>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand">
              <ShoppingBag size={19} />
            </span>
            <div>
              <h2 className="font-semibold text-ink">Miscellaneous spending</h2>
              <p className="text-sm text-ink-faint">
                {formatCurrency(miscSpent)} / {formatCurrency(miscCap)}
              </p>
            </div>
          </div>
          <Link to="/expenses" className="text-sm font-medium text-brand hover:text-brand/80">
            View expenses
          </Link>
        </div>

        <ProgressBar ratio={miscUsageRatio(miscSpent, miscCap)} tone={MISC_TONE[miscLevel]} />

        {miscLevel === "gentle" && (
          <p className="text-sm text-warn">{MISC_MESSAGES.gentle}</p>
        )}
        {miscLevel === "strong" && (
          <p className="text-sm font-medium text-warn">{MISC_MESSAGES.strong}</p>
        )}
        {miscSpent >= miscCap && miscCap > 0 && miscOver === 0 && (
          <p className="text-sm font-medium text-bad">
            You've reached your miscellaneous spending limit.
          </p>
        )}
        {miscOver > 0 && (
          <p className="text-sm font-medium text-bad">
            You've exceeded your miscellaneous spending budget by {formatCurrency(miscOver)}.
          </p>
        )}
      </Card>
    </div>
  );
}
