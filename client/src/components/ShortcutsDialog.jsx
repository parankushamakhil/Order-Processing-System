import { modKeyLabel } from '../hooks/useGlobalShortcuts.js';
import { Modal } from './Modal.jsx';

function Keys({ keys }) {
  return (
    <span className="shortcut-keys">
      {keys.map((key) => (
        <kbd className="kbd" key={key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The shortcut reference.
 *
 * A palette without a discoverable keymap is a secret. This exists so the
 * keyboard layer is documented inside the product instead of in a README nobody
 * opens, and it is reachable from the account menu as well as from `?`.
 */
export default function ShortcutsDialog({ open, onClose }) {
  const mod = modKeyLabel();

  const groups = [
    {
      title: 'Search and commands',
      rows: [
        { label: 'Command palette', keys: [mod, 'K'] },
        { label: 'Focus the catalogue search', keys: ['/'] },
        { label: 'Show this list', keys: ['?'] },
        { label: 'Dismiss the top layer', keys: ['Esc'] },
      ],
    },
    {
      title: 'Go to',
      rows: [
        { label: 'Catalogue', keys: ['g', 's'] },
        { label: 'Cart', keys: ['g', 'c'] },
        { label: 'Orders', keys: ['g', 'o'] },
        { label: 'Operations console', keys: ['g', 'a'] },
      ],
    },
    {
      title: 'In the palette',
      rows: [
        { label: 'Move through results', keys: ['↑', '↓'] },
        { label: 'Open the highlighted result', keys: ['↵'] },
      ],
    },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      subtitle="Everything in the console is reachable without the mouse."
    >
      <div className="shortcut-groups">
        {groups.map((group) => (
          <section className="shortcut-group" key={group.title}>
            <h3 className="shortcut-group__title">{group.title}</h3>
            {group.rows.map((row) => (
              <div className="shortcut-row" key={row.label}>
                <span className="shortcut-row__label">{row.label}</span>
                <Keys keys={row.keys} />
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
