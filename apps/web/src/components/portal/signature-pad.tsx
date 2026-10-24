import { Button, cn } from '@plastago/ui';
import { EraserIcon } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

export interface SignaturePadProps {
  id: string;
  label: string;
  /** The drawing as a PNG data URL, or null once cleared. */
  onChange: (dataUrl: string | null) => void;
  error?: string | undefined;
}

/**
 * A drawn signature (Matt, 21 Oct — "them having to sign it").
 *
 * Pointer events, so a finger on a phone, a pen on a tablet and a mouse on a
 * desk all draw the same way. The pad is always white with dark ink, in either
 * theme, because the PNG it produces is printed on the white signed copy.
 */
export function SignaturePad({ id, label, onChange, error }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Sized to its box at the screen's pixel density, so the ink is not blurred.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2.2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#111827';
  }, []);

  const at = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const start = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const point = at(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
    // A dot, so a tap still marks the pad.
    context.lineTo(point.x + 0.1, point.y + 0.1);
    context.stroke();
  };

  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const point = at(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const end = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    setEmpty(false);
    onChange(event.currentTarget.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label} <span className="text-destructive">*</span>
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={empty}>
          <EraserIcon aria-hidden />
          Clear
        </Button>
      </div>
      <canvas
        id={id}
        ref={canvasRef}
        role="img"
        aria-label={empty ? `${label} — empty` : `${label} — signed`}
        aria-invalid={error !== undefined}
        tabIndex={0}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className={cn(
          'block h-36 w-full touch-none rounded-lg border bg-white',
          error === undefined ? 'border-border' : 'border-destructive',
        )}
      />
      <p className="text-xs text-muted-foreground">Sign with your finger, a pen or the mouse.</p>
      {error !== undefined && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
