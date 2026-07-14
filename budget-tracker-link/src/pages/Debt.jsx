import { useState } from "react";
import { CreditCard } from "lucide-react";
import { useBudget } from "../context/BudgetContext";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import ListRow from "../components/ListRow";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import Button from "../components/Button";
import { TextField, AmountField } from "../components/FormField";
import { sumDebtPayments, formatCurrency } from "../utils/calculations";

const emptyForm = { name: "", monthlyPayment: "", remainingBalance: "", interestRate: "" };

export default function Debt() {
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

  const openEdit = (debt) => {
    setForm({
      name: debt.name,
      monthlyPayment: String(debt.monthlyPayment),
      remainingBalance: debt.remainingBalance != null ? String(debt.remainingBalance) : "",
      interestRate: debt.interestRate != null ? String(debt.interestRate) : "",
    });
    setEditingId(debt.id);
    setError("");
    setModalOpen(true);
  };

  const save = () => {
    if (!form.name.trim()) {
      setError("Give this debt a name.");
      return;
    }
    if (!(Number(form.monthlyPayment) > 0)) {
      setError("Monthly payment must be greater than zero.");
      return;
    }
    const payload = {
      name: form.name.trim(),
      monthlyPayment: Number(form.monthlyPayment),
      remainingBalance: form.remainingBalance ? Number(form.remainingBalance) : null,
      interestRate: form.interestRate ? Number(form.interestRate) : null,
    };
    if (editingId) {
      dispatch({ type: "UPDATE_DEBT", id: editingId, payload });
    } else {
      dispatch({ type: "ADD_DEBT", payload });
    }
    setModalOpen(false);
  };

  const total = sumDebtPayments(state.debts);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Debt"
        subtitle="Loans and credit cards you're paying down."
        onAdd={openAdd}
        addLabel="Add debt"
      />

      <Card padding="p-5" className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink-soft">Total monthly debt payments</span>
        <span className="text-xl font-semibold text-ink">{formatCurrency(total)}</span>
      </Card>

      <Card padding="p-2">
        {state.debts.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="No debts added"
            description="Add a loan or credit card to track its monthly payment."
            action={
              <Button onClick={openAdd} size="sm">
                Add debt
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-line">
            {state.debts.map((debt) => (
              <ListRow
                key={debt.id}
                title={debt.name}
                subtitle={
                  debt.remainingBalance != null
                    ? `${formatCurrency(debt.remainingBalance)} remaining`
                    : undefined
                }
                amount={`${formatCurrency(debt.monthlyPayment)} / mo`}
                meta={debt.interestRate != null ? `${debt.interestRate}% APR` : undefined}
                onEdit={() => openEdit(debt)}
                onDelete={() => dispatch({ type: "DELETE_DEBT", id: debt.id })}
              />
            ))}
          </div>
        )}
      </Card>

      <Modal
        title={editingId ? "Edit debt" : "Add debt"}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
      >
        <div className="space-y-4">
          <TextField
            label="Debt name"
            placeholder="e.g. Visa card"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus
          />
          <AmountField
            label="Monthly payment"
            placeholder="0"
            value={form.monthlyPayment}
            onChange={(e) => setForm((f) => ({ ...f, monthlyPayment: e.target.value }))}
          />
          <AmountField
            label="Remaining balance (optional)"
            placeholder="0"
            value={form.remainingBalance}
            onChange={(e) => setForm((f) => ({ ...f, remainingBalance: e.target.value }))}
          />
          <TextField
            label="Interest rate % (optional)"
            type="number"
            step="0.01"
            min="0"
            placeholder="0"
            value={form.interestRate}
            onChange={(e) => setForm((f) => ({ ...f, interestRate: e.target.value }))}
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
