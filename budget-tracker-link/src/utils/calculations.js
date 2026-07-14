import { MISC_CATEGORY } from "./categories";

const WEEKS_PER_MONTH = 52 / 12;
const BIWEEKS_PER_MONTH = 26 / 12;

// Normalizes any income frequency into an estimated monthly amount.
export function toMonthlyAmount(amount, frequency) {
  const value = Number(amount) || 0;
  switch (frequency) {
    case "weekly":
      return value * WEEKS_PER_MONTH;
    case "biweekly":
      return value * BIWEEKS_PER_MONTH;
    case "semimonthly":
      return value * 2;
    case "monthly":
    default:
      return value;
  }
}

export function sumMonthlyIncome(incomeSources) {
  return incomeSources.reduce(
    (total, source) => total + toMonthlyAmount(source.amount, source.frequency),
    0
  );
}

export function sumExpenses(expenses) {
  return expenses.reduce((total, expense) => total + (Number(expense.amount) || 0), 0);
}

export function sumExpensesByType(expenses, type) {
  return sumExpenses(expenses.filter((expense) => expense.type === type));
}

export function sumDebtPayments(debts) {
  return debts.reduce((total, debt) => total + (Number(debt.monthlyPayment) || 0), 0);
}

export function sumMiscSpending(expenses) {
  return sumExpenses(expenses.filter((expense) => expense.category === MISC_CATEGORY));
}

export function miscUsageRatio(spent, cap) {
  if (!cap || cap <= 0) return 0;
  return spent / cap;
}

export function miscWarningLevel(spent, cap) {
  const ratio = miscUsageRatio(spent, cap);
  if (ratio >= 1) return "over";
  if (ratio >= 0.9) return "strong";
  if (ratio >= 0.8) return "gentle";
  return "none";
}

export function expensesByCategory(expenses) {
  const totals = new Map();
  for (const expense of expenses) {
    const current = totals.get(expense.category) || 0;
    totals.set(expense.category, current + (Number(expense.amount) || 0));
  }
  return [...totals.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
}

export function largestCategory(expenses) {
  const sorted = expensesByCategory(expenses);
  return sorted.length > 0 ? sorted[0] : null;
}

const BALANCE_TOLERANCE = 1;

// income, totalExpenses, and debtPayments are separate because expenses and
// debt payments are tracked in different parts of the app but both reduce
// what's left over.
export function getBudgetStatus(income, totalOutgoing) {
  const remaining = income - totalOutgoing;
  if (Math.abs(remaining) <= BALANCE_TOLERANCE) {
    return { status: "balanced", remaining };
  }
  if (remaining < 0) {
    return { status: "overspending", remaining };
  }
  return { status: "surplus", remaining };
}

export function formatCurrency(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return safeValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function formatCurrencyPrecise(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return safeValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}
