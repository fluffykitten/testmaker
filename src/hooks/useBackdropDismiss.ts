import { useRef, useCallback } from 'react';

/**
 * Hook to prevent accidental modal dismissal when selecting text, adjusting sliders,
 * or dragging the mouse from inside a modal/popover out onto the backdrop.
 *
 * Only invokes onClose if the pointerdown/mousedown AND the click event
 * both originated directly on the backdrop itself (e.target === e.currentTarget).
 */
export function useBackdropDismiss(onClose?: () => void) {
  const isMouseDownOnBackdrop = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      isMouseDownOnBackdrop.current = true;
    } else {
      isMouseDownOnBackdrop.current = false;
    }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget && isMouseDownOnBackdrop.current) {
      onClose?.();
    }
    isMouseDownOnBackdrop.current = false;
  }, [onClose]);

  return {
    onMouseDown: handleMouseDown,
    onClick: handleClick,
  };
}
