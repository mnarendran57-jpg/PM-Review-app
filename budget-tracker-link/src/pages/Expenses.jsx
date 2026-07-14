import { useState } from "react";
import { Receipt } from "lucide-react";
import { useBudget } from "../context/BudgetContext";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import ListRow from "../components/ListRow";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import Button from "../components/Button";
import { TextField, AmountField, SelectField, TextAreaField } from "../components/FormField";
import { DEFAULT_CATEGORIES } from "../utils/categories";
import { sumExpenses, formatCurrency } from "../utils/calculations";

const emptyForm = {
  name: "",
  amount: "",
  category: DEFAULT_CATEGORIES[0],
  type: "fixed",
  dueDate: "",
  notes: "",
};

export default function Expenses() {
  const { state, dispatch } = useBudget();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [customCategory, setCustomCategory] = useState("");

  const categories = [...new Set([...DEFAULT_CATEGORIES, ...state.expenses.map((e) => e.category)])];

  const openAdd = () => {
    setForm(emptyForm);
    setEditingId(null);
    setCustomCategory("");
    setError("");
    setModalOpen(true);
  };

  const openEdit = (expense) => {
    setForm({
      name: expense.name,
      amount: String(expense.amount),
      category: expense.category,
      type: expense.type,
      dueDate: expense.dueDate || "",
      notes: expense.notes || "",
    });
    setEditingId(expense.id);
    setCustomCategory("");
    setError("");
    setModalOpen(true);
  };

  const save = () => {
    const category = form.category === "__custom__" ? customCategory.trim() : form.category;
    if (!form.name.trim()) {
      setError("Give this expense a name.");
      return;
    }
    if (!(Number(form.amount) > 0)) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (!category) {
      setError("Choose or enter a category.");
      return;
    }
    const payload = {
      name: form.name.trim(),
      amount: Number(form.amount),
      category,
      type: form.type,
      dueDate: form.dueDate || "",
      notes: form.notes.trim(),
    };
    if (editingId) {
      dispatch({ type: "UPDATE_EXPENSE", id: editingId, payload });
    } else {
      dispatch({ type: "ADD_EXPENSE", payload });
    }
    setModalOpen(false);
  };

  const total = sumExpenses(state.expenses);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        subtitle="Everything you spend money on each month."
        onAdd={openAdd}
        addLabel="Add expense"
      />

      <Card padding="p-5" className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink-soft">Total monthly expenses</span>
        <span className="text-xl font-semibold text-ink">{formatCurrency(total)}</span>
      </Card>

      <Card padding="p-2">
        {state.expenses.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No expenses yet"
            description="Add your first expense to start tracking where your money goes."
            action={
              <Button onClick={openAdd} size="sm">
                Add expense
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-line">
            {state.expenses.map((expense) => (
              <ListRow
                key={expense.id}
                title={expense.name}
                subtitle={`${expense.category} · ${expense.type === "fixed" ? "Fixed" : "Variable"}`}
                amount={formatCurrency(Number(expense.amount))}
                meta={expense.dueDate ? `Due ${expense.dueDate}` : undefined}
                onEdit={() => openEdit(expense)}
                onDelete={() => dispatch({ type: "DELETE_EXPENSE", id: expense.id })}
              />
            ))}
          </div>
        )}
      </Card>

      <Modal
        title={editingId ? "Edit expense" : "Add expense"}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
      >
        <div className="space-y-4">
          <TextField
            label="Name"
            placeholder="e.g. Netflix"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus
          />
          <AmountField
            label="Amount"
            placeholder="0"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          />
          <SelectField
            label="Category"
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="__custom__">Custom category…</option>
          </SelectField>
          {form.category === "__custom__" && (
            <TextField
              label="Custom category name"
              placeholder="e.g. Pet care"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
            />
          )}
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-soft">Type</span>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "fixed", label: "Fixed" },
                { value: "variable", label: "Variable" },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, type: option.value }))}
                  className={`h-11 rounded-control border text-sm font-medium transition-colors ${
                    form.type === option.value
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-line text-ink-soft hover:bg-surface-muted"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <TextField
            label="Due date (optional)"
            type="date"
            value={form.dueDate}
            onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
          />
          <TextAreaField
            label="Notes (optional)"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
          {error && <p className="text-sm font-medium text-bad">{error}</p>}
          <Button className="w-full" onClick={save}>
            Save
          </Button>
        </div>
      </Modal>
    </div>
  );
}
