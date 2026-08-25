import React, { useState, useEffect } from 'react';
import './ScientificCalculatorModal.css';

interface ScientificCalculatorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ScientificCalculatorModal: React.FC<ScientificCalculatorModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [expression, setExpression] = useState<string>('');
  const [result, setResult] = useState<string>('0');
  const [lastAnswer, setLastAnswer] = useState<string>('0');

  // Evaluate Expression Safely
  const evaluateExpression = (expr: string) => {
    if (!expr.trim()) {
      setResult('0');
      return;
    }

    try {
      // Transform human expressions to JS math
      let sanitized = expr
        .replace(/×/g, '*')
        .replace(/÷/g, '/')
        .replace(/π/g, 'Math.PI')
        .replace(/Ans/g, lastAnswer || '0')
        .replace(/\^/g, '**')
        .replace(/√\(([^)]+)\)/g, 'Math.sqrt($1)')
        .replace(/√(\d+(\.\d+)?)/g, 'Math.sqrt($1)')
        .replace(/log\(([^)]+)\)/g, 'Math.log10($1)')
        .replace(/ln\(([^)]+)\)/g, 'Math.log($1)');

      // Allow only numbers, math functions, and basic operators
      if (/[^0-9+\-*/().%\sMathPIsqrtlog10e*]/.test(sanitized)) {
        return;
      }

      // eslint-disable-next-line no-eval
      const evalVal = Function(`"use strict"; return (${sanitized})`)();
      if (typeof evalVal === 'number' && !isNaN(evalVal) && isFinite(evalVal)) {
        // Round cleanly to 6 decimal places if needed
        const formatted = Number(evalVal.toFixed(6)).toString();
        setResult(formatted);
      }
    } catch {
      // Expression incomplete while typing, keep current result
    }
  };

  const handleInput = (char: string) => {
    setExpression((prev) => {
      const next = prev + char;
      evaluateExpression(next);
      return next;
    });
  };

  const handleClear = () => {
    setExpression('');
    setResult('0');
  };

  const handleDelete = () => {
    setExpression((prev) => {
      const next = prev.slice(0, -1);
      evaluateExpression(next);
      return next;
    });
  };

  const handleEquals = () => {
    if (result && result !== 'Error') {
      setLastAnswer(result);
      setExpression(result);
    }
  };

  const handleApplyFunction = (func: string) => {
    setExpression((prev) => {
      let next = '';
      if (func === 'sqrt') next = `${prev}√(`;
      else if (func === 'sq') next = `${prev}^2`;
      else if (func === 'exp10') next = `${prev}×10^(`;
      else if (func === 'log') next = `${prev}log(`;
      else if (func === 'ln') next = `${prev}ln(`;
      else if (func === 'pi') next = `${prev}π`;
      else if (func === 'pct') next = `${prev}*(1/100)`;
      else if (func === 'ans') next = `${prev}Ans`;
      evaluateExpression(next);
      return next;
    });
  };

  // Physical Keyboard Listener
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        handleInput(e.key);
      } else if (e.key === '+' || e.key === '-' || e.key === '(' || e.key === ')' || e.key === '.') {
        handleInput(e.key);
      } else if (e.key === '*') {
        handleInput('×');
      } else if (e.key === '/') {
        handleInput('÷');
      } else if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        handleEquals();
      } else if (e.key === 'Backspace') {
        handleDelete();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, result]);

  if (!isOpen) return null;

  return (
    <div className="sc-modal-backdrop animate-fade-in" onClick={onClose}>
      <div className="sc-modal-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sc-header">
          <div className="sc-title-wrap">
            <span>🧮</span>
            <strong>Scientific Calculator</strong>
          </div>
          <button type="button" className="sc-close-btn" onClick={onClose} title="Close Calculator">
            ✕
          </button>
        </div>

        {/* Display Screen */}
        <div className="sc-screen">
          <div className="sc-expr-row">{expression || '0'}</div>
          <div className="sc-res-row">{result}</div>
        </div>

        {/* Scientific & Arithmetic Keypad */}
        <div className="sc-keypad">
          {/* Scientific Row 1 */}
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('sqrt')}>√x</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('sq')}>x²</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleInput('^')}>xʸ</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('exp10')}>×10ˣ</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('log')}>log</button>

          {/* Scientific Row 2 */}
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('ln')}>ln</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('pi')}>π</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleInput('(')}>(</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleInput(')')}>)</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('pct')}>%</button>

          {/* Main Keypad Row 1 */}
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('7')}>7</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('8')}>8</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('9')}>9</button>
          <button type="button" className="sc-btn sc-btn--del" onClick={handleDelete}>DEL</button>
          <button type="button" className="sc-btn sc-btn--ac" onClick={handleClear}>AC</button>

          {/* Main Keypad Row 2 */}
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('4')}>4</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('5')}>5</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('6')}>6</button>
          <button type="button" className="sc-btn sc-btn--op" onClick={() => handleInput('×')}>×</button>
          <button type="button" className="sc-btn sc-btn--op" onClick={() => handleInput('÷')}>÷</button>

          {/* Main Keypad Row 3 */}
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('1')}>1</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('2')}>2</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('3')}>3</button>
          <button type="button" className="sc-btn sc-btn--op" onClick={() => handleInput('+')}>+</button>
          <button type="button" className="sc-btn sc-btn--op" onClick={() => handleInput('-')}>−</button>

          {/* Main Keypad Row 4 */}
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('0')}>0</button>
          <button type="button" className="sc-btn sc-btn--num" onClick={() => handleInput('.')}>.</button>
          <button type="button" className="sc-btn sc-btn--fn" onClick={() => handleApplyFunction('ans')}>Ans</button>
          <button type="button" className="sc-btn sc-btn--eq" onClick={handleEquals} style={{ gridColumn: 'span 2' }}>=</button>
        </div>
      </div>
    </div>
  );
};
