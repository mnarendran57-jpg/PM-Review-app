import { useState } from "react";
import { Wallet } from "lucide-react";
import { useBudget } from "../context/BudgetContext";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import ListRow from "../components/ListRow";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import Button from "../components/Button";
import { TextField, AmountField, SelectField } from "../components/FormField";
import { sumMonthlyIncome, toMonthlyAmount, formatCurrency } from "../utils/calculations";

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "semimonthly", label: "Semi-monthly" },
  { value: "monthly", label: "Monthly" },
];

const FREQUENCY_LABEL = Object.fromEntries(FREQUENCIES.map((f) => [f.value, f.label]));

const emptyForm = { name: "", amount: "", frequency: "monthly" };

export default function Income() {
  const { state, dispatch } = useBudget();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");

  const openAdd = () => {
    setForm(emptyForm);
    setEditingId(null);
    setError("");
    setModalOpen(true);
  };

  const openEdit = (source) => {
    setForm({ name: source.name, amount: String(source.amount), frequency: source.frequency });
    setEditingId(source.id);
    setError("");
    setModalOpen(true);
  };

  const save = () => {
    if (!form.name.trim()) {
      setError("Give this income source a name.");
      return;
    }
    if (!(Number(form.amount) > 0)) {
      setError("Amount must be greater than zero.");
      return;
    }
    const payload = { name: form.name.trim(), amount: Number(form.amount), frequency: form.frequency };
    if (editingId) {
      dispatch({ type: "UPDATE_INCOME", id: editingId, payload });
    } else {
      dispatch({ type: "ADD_INCOME", payload });
    }
    setModalOpen(false);
  };

  const monthlyTotal = sumMonthlyIncome(state.income);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Income"
        subtitle="Every paycheck you count on each month."
        onAdd={openAdd}
        addLabel="Add income"
      />

      <Card padding="p-5" className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink-soft">Estimated monthly income</span>
        <span className="text-xl font-semibold text-ink">{formatCurrency(monthlyTotal)}</span>
      </Card>

      <Card padding="p-2">
        {state.income.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No income sources yet"
            description="Add your paycheck to get started."
            action={
              <Button onClick={openAdd} size="sm">
                Add income
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-line">
            {state.income.map((source) => (
              <ListRow
                key={source.id}
                title={source.name}
                subtitle={FREQUENCY_LABEL[source.frequency]}
                amount={formatCurrency(Number(source.amount))}
                meta={`${formatCurrency(toMonthlyAmount(source.amount, source.frequency))} / mo`}
                onEdit={() => openEdit(source)}
                onDelete={() => dispatch({ type: "DELETE_INCOME", id: source.id })}
              />
            ))}
          </div>
        )}
      </Card>

      <Modal
        title={editingId ? "Edit income" : "Add income"}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
      >
        <div className="space-y-4">
          <TextField
            label="Source name"
            placeholder="e.g. Main job"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus
          />
          <div className="grid grid-cols-2 gap-3">
            <AmountField
              label="Amount"
              placeholder="0"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            />
            <SelectField
              label="Frequency"
              value={form.frequency}
              onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))}
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </SelectField>
          </div>
          {error && <p className="text-sm font-medium text-bad">{error}</p>}
          <Button className="w-full" onClick={save}>
            Save
          </Button>
        </div>
      </Modal>
    </div>
  );
}
