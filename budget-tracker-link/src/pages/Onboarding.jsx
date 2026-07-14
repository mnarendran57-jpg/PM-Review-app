import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Wallet, Target } from "lucide-react";
import { useBudget } from "../context/BudgetContext";
import Card from "../components/Card";
import Button from "../components/Button";
import { TextField, AmountField, SelectField } from "../components/FormField";
import { formatCurrency } from "../utils/calculations";
import { toMonthlyAmount } from "../utils/calculations";

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "semimonthly", label: "Semi-monthly" },
  { value: "monthly", label: "Monthly" },
];

function emptySource() {
  return { name: "", amount: "", frequency: "monthly" };
}

export default function Onboarding() {
  const { dispatch } = useBudget();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [sources, setSources] = useState([emptySource()]);
  const [miscCap, setMiscCap] = useState("");
  const [error, setError] = useState("");

  const updateSource = (index, patch) => {
    setSources((prev) => prev.map((source, i) => (i === index ? { ...source, ...patch } : source)));
  };

  const addSource = () => setSources((prev) => [...prev, emptySource()]);
  const removeSource = (index) => setSources((prev) => prev.filter((_, i) => i !== index));

  const totalMonthly = sources.reduce(
    (sum, source) => sum + toMonthlyAmount(source.amount, source.frequency),
    0
  );

  const goToStepTwo = () => {
    const valid = sources.every((source) => source.name.trim() && Number(source.amount) > 0);
    if (!valid) {
      setError("Please give each income source a name and an amount greater than zero.");
      return;
    }
    setError("");
    setStep(2);
  };

  const finish = () => {
    const cap = Number(miscCap);
    if (!(cap > 0)) {
      setError("Enter a miscellaneous spending limit greater than zero.");
      return;
    }
    dispatch({
      type: "COMPLETE_ONBOARDING",
      income: sources.map((source) => ({ ...source, amount: Number(source.amount) })),
      miscCap: cap,
    });
    navigate("/");
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Welcome to Clarity</h1>
          <p className="mt-1.5 text-sm text-ink-faint">
            Let's set up your budget. This takes less than five minutes.
          </p>
        </div>

        <div className="mb-6 flex items-center justify-center gap-2">
          {[1, 2].map((n) => (
            <span
              key={n}
              className={`h-1.5 w-10 rounded-full ${n <= step ? "bg-brand" : "bg-line"}`}
            />
          ))}
        </div>

        {step === 1 && (
          <Card className="space-y-5">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand">
                <Wallet size={19} />
              </span>
              <div>
                <h2 className="font-semibold text-ink">What's your income?</h2>
                <p className="text-sm text-ink-faint">Add one or more paychecks.</p>
              </div>
            </div>

            <div className="space-y-4">
              {sources.map((source, index) => (
                <div key={index} className="space-y-3 rounded-control bg-surface-muted p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Income {index + 1}
                    </span>
                    {sources.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeSource(index)}
                        aria-label="Remove income source"
                        className="text-ink-faint hover:text-bad"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  <TextField
                    label="Source name"
                    placeholder="e.g. Main job"
                    value={source.name}
                    onChange={(e) => updateSource(index, { name: e.target.value })}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <AmountField
                      label="Amount"
                      placeholder="0"
                      value={source.amount}
                      onChange={(e) => updateSource(index, { amount: e.target.value })}
                    />
                    <SelectField
                      label="Frequency"
                      value={source.frequency}
                      onChange={(e) => updateSource(index, { frequency: e.target.value })}
                    >
                      {FREQUENCIES.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addSource}
              className="flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand/80"
            >
              <Plus size={16} /> Add another income source
            </button>

            {totalMonthly > 0 && (
              <p className="text-sm text-ink-soft">
                Estimated monthly income:{" "}
                <span className="font-semibold text-ink">{formatCurrency(totalMonthly)}</span>
              </p>
            )}

            {error && <p className="text-sm font-medium text-bad">{error}</p>}

            <Button className="w-full" onClick={goToStepTwo}>
              Continue
            </Button>
          </Card>
        )}

        {step === 2 && (
          <Card className="space-y-5">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand">
                <Target size={19} />
              </span>
              <div>
                <h2 className="font-semibold text-ink">Set a miscellaneous spending limit</h2>
                <p className="text-sm text-ink-faint">
                  What's the maximum amount you'd like to spend on miscellaneous purchases each
                  month?
                </p>
              </div>
            </div>

            <AmountField
              label="Monthly limit"
              placeholder="300"
              value={miscCap}
              onChange={(e) => setMiscCap(e.target.value)}
              autoFocus
            />

            {error && <p className="text-sm font-medium text-bad">{error}</p>}

            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button className="flex-1" onClick={finish}>
                Finish setup
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
