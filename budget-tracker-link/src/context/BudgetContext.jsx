import { createContext, useContext, useEffect, useReducer } from "react";

const STORAGE_KEY = "clarity-budget-tracker";

const initialState = {
  onboarded: false,
  income: [],
  expenses: [],
  debts: [],
  savingsGoal: 0,
  currentSavings: 0,
  miscCap: 0,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    return { ...initialState, ...JSON.parse(raw) };
  } catch {
    return initialState;
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function reducer(state, action) {
  switch (action.type) {
    case "COMPLETE_ONBOARDING":
      return {
        ...state,
        onboarded: true,
        income: action.income,
        miscCap: action.miscCap,
      };

    case "ADD_INCOME":
      return { ...state, income: [...state.income, { id: makeId(), ...action.payload }] };
    case "UPDATE_INCOME":
      return {
        ...state,
        income: state.income.map((item) =>
          item.id === action.id ? { ...item, ...action.payload } : item
        ),
      };
    case "DELETE_INCOME":
      return { ...state, income: state.income.filter((item) => item.id !== action.id) };

    case "ADD_EXPENSE":
      return { ...state, expenses: [...state.expenses, { id: makeId(), ...action.payload }] };
    case "UPDATE_EXPENSE":
      return {
        ...state,
        expenses: state.expenses.map((item) =>
          item.id === action.id ? { ...item, ...action.payload } : item
        ),
      };
    case "DELETE_EXPENSE":
      return { ...state, expenses: state.expenses.filter((item) => item.id !== action.id) };

    case "ADD_DEBT":
      return { ...state, debts: [...state.debts, { id: makeId(), ...action.payload }] };
    case "UPDATE_DEBT":
      return {
        ...state,
        debts: state.debts.map((item) =>
          item.id === action.id ? { ...item, ...action.payload } : item
        ),
      };
    case "DELETE_DEBT":
      return { ...state, debts: state.debts.filter((item) => item.id !== action.id) };

    case "SET_SAVINGS_GOAL":
      return { ...state, savingsGoal: action.value };
    case "SET_CURRENT_SAVINGS":
      return { ...state, currentSavings: action.value };
    case "SET_MISC_CAP":
      return { ...state, miscCap: action.value };

    default:
      return state;
  }
}

const BudgetContext = createContext(null);

export function BudgetProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  return <BudgetContext.Provider value={{ state, dispatch }}>{children}</BudgetContext.Provider>;
}

export function useBudget() {
  const context = useContext(BudgetContext);
  if (!context) {
    throw new Error("useBudget must be used within a BudgetProvider");
  }
  return context;
}
