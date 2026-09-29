import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [modal, setModal] = useState(null); // { title, message, actions }
  const resolveRef = useRef(null);

  // Returns a promise that resolves with the clicked action's `value`,
  // or null if dismissed via the overlay/Escape.
  const confirm = useCallback(({ title = "", message = "", actions = [] }) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setModal({ title, message, actions });
    });
  }, []);

  const finish = useCallback((value) => {
    if (!resolveRef.current) return;
    resolveRef.current(value);
    resolveRef.current = null;
    setModal(null);
  }, []);

  useEffect(() => {
    if (!modal) return;
    const onKeydown = (e) => {
      if (e.key === "Escape") finish(null);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [modal, finish]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <div
        id="modalOverlay"
        className={modal ? "" : "hidden"}
        onClick={(e) => {
          if (e.target.id === "modalOverlay") finish(null);
        }}
      >
        {modal && (
          <div id="modalBox" role="dialog" aria-modal="true">
            <h3 id="modalTitle">{modal.title}</h3>
            <p id="modalMessage">{modal.message}</p>
            <div id="modalActions">
              {modal.actions.map((action) => (
                <button
                  key={action.value}
                  className={action.variant || "secondary"}
                  onClick={() => finish(action.value)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
