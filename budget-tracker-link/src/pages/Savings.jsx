import { useState } from "react";
import { PiggyBank } from "lucide-react";
import { useBudget } from "../context/BudgetContext";
import Card from "../components/Card";
import Button from "../components/Button";
import ProgressBar from "../components/ProgressBar";
import { AmountField } from "../components/FormField";
import { formatCurrency } from "../utils/calculations";

export default function Savings() {
  const { state, dispatch } = useBudget();
  const [goal, setGoal] = useState(String(state.savingsGoal || ""));
  const [current, setCurrent] = useState(String(state.currentSavings || ""));
  const [saved, setSaved] = useState(false);

  const ratio = state.savingsGoal > 0 ? state.currentSavings / state.savingsGoal : 0;

  const save = () => {
    dispatch({ type: "SET_SAVINGS_GOAL", value: Number(goal) || 0 });
    dispatch({ type: "SET_CURRENT_SAVINGS", value: Number(current) || 0 });
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Savings</h1>
        <p className="mt-1 text-sm text-ink-faint">Set a goal and track your progress toward it.</p>
      </div>

      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-good-soft text-good">
            <PiggyBank size={19} />
          </span>
          <div>
            <p className="font-semibold text-ink">
              {formatCurrency(state.currentSavings)}{" "}
              <span className="text-sm font-normal text-ink-faint">
                of {formatCurrency(state.savingsGoal)} goal
              </span>
            </p>
          </div>
        </div>
        <ProgressBar ratio={ratio} tone="good" />
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold text-ink">Update your savings</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AmountField
            label="Monthly savings goal"
            placeholder="0"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <AmountField
            label="Current savings"
            placeholder="0"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <Button onClick={save}>{saved ? "Saved" : "Save"}</Button>
      </Card>
    </div>
  );
}
