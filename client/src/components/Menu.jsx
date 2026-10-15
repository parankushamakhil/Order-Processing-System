import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckIcon } from './icons.jsx';

function isActionable(item) {
  return Boolean(item) && item.type !== 'separator' && item.type !== 'label';
}

/**
 * A popover menu with the keyboard contract people actually expect.
 *
 * Why not just a <select> or a stack of buttons: theme choice and account actions
 * need labels, descriptions, check state and grouping, which a native select
 * cannot express. Why not cycle a single button through the options: a control
 * that never shows its current state is guesswork, and with three options the
 * cycle costs two clicks to reach a specific one.
 *
 * Implements the WAI-ARIA menu pattern: roving DOM focus (real focus, not just a
 * highlight, so screen readers read the item), ArrowUp/ArrowDown through
 * actionable items only, Home/End, Escape to dismiss and restore focus to the
 * trigger, and dismissal on outside pointer-down.
 *
 * Usage — `children` is a render prop so the trigger itself carries the ARIA
 * wiring and stays whatever element the call site needs:
 *
 *   <Menu items={items} side="up">
 *     {(triggerProps) => <button {...triggerProps}>Account</button>}
 *   </Menu>
 */
export function Menu({
  items,
  children,
  align = 'end',
  side = 'down',
  labelledBy,
  minWidth,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  const menuId = useId();

  const actionableIndexes = useMemo(
    () => items.reduce((acc, item, index) => (isActionable(item) ? [...acc, index] : acc), []),
    [items],
  );

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const focusAt = useCallback(
    (position) => {
      const index = actionableIndexes[position];
      itemRefs.current[index]?.focus({ preventScroll: true });
    },
    [actionableIndexes],
  );

  // Always the first item, whichever way the panel opens. Focusing the last
  // item in an upward-opening menu puts the *nearest-to-the-trigger* entry under
  // the cursor, and in an account menu that entry is Sign out — so a stray Enter
  // would end the session. Position is a layout decision; the default selection
  // should not depend on it.
  useEffect(() => {
    if (!open) return;
    focusAt(0);
    // Intentionally only on open: later arrow moves are handled locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) close(false);
    }
    // Dismiss on scroll/resize: a panel anchored to a moving trigger is worse
    // than a closed panel.
    function onDismiss() {
      close(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open, close]);

  function moveFocus(delta) {
    const active = itemRefs.current.findIndex((node) => node === document.activeElement);
    const current = actionableIndexes.indexOf(active);
    const next = current === -1 ? 0 : (current + delta + actionableIndexes.length) % actionableIndexes.length;
    focusAt(next);
  }

  function onMenuKeyDown(event) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(-1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(actionableIndexes.length - 1);
        break;
      case 'Tab':
        // Tabbing away is a dismissal, not a trap: the menu is a transient layer.
        close(false);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      default:
        break;
    }
  }

  function onTriggerKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  }

  const triggerProps = {
    ref: triggerRef,
    onClick: () => setOpen((value) => !value),
    onKeyDown: onTriggerKeyDown,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  };

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {typeof children === 'function' ? children(triggerProps) : null}

      {open ? (
        <div
          className="menu"
          id={menuId}
          role="menu"
          aria-labelledby={labelledBy}
          data-align={align}
          data-side={side}
          style={minWidth ? { minWidth } : undefined}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => {
            if (item.type === 'separator') {
              return <hr className="menu__sep" key={`sep-${index}`} role="separator" />;
            }
            if (item.type === 'label') {
              return (
                <p className="menu__section" key={`label-${index}`}>
                  {item.label}
                </p>
              );
            }

            const checkable = typeof item.checked === 'boolean';
            return (
              <button
                key={item.id ?? `${item.label}-${index}`}
                type="button"
                role={checkable ? 'menuitemradio' : 'menuitem'}
                aria-checked={checkable ? item.checked : undefined}
                className={`menu__item${item.tone === 'danger' ? ' menu__item--danger' : ''}`}
                disabled={item.disabled}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                onClick={() => {
                  close();
                  item.onSelect?.();
                }}
              >
                {item.icon ? <item.icon size={15} className="menu__icon" /> : null}
                <span className="menu__text">
                  <span className="menu__label">{item.label}</span>
                  {item.hint ? <span className="menu__hint">{item.hint}</span> : null}
                </span>
                {item.trailing ? <span className="menu__trailing">{item.trailing}</span> : null}
                {checkable ? (
                  <span className="menu__check" aria-hidden="true">
                    {item.checked ? <CheckIcon size={14} strokeWidth={2.25} /> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
