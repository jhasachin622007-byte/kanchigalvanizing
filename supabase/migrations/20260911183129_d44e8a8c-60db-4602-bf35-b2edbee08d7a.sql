CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read settings" ON public.app_settings
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin insert settings" ON public.app_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE POLICY "admin update settings" ON public.app_settings
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE POLICY "admin delete settings" ON public.app_settings
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'::app_role));

ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
ALTER TABLE public.app_settings REPLICA IDENTITY FULL;

CREATE TABLE public.active_sessions (
  user_id UUID NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  device_info TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.active_sessions TO authenticated;
GRANT ALL ON public.active_sessions TO service_role;

ALTER TABLE public.active_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user read own session"
ON public.active_sessions FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "user insert own session"
ON public.active_sessions FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user update own session"
ON public.active_sessions FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user delete own session"
ON public.active_sessions FOR DELETE TO authenticated
USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.active_sessions;
ALTER TABLE public.active_sessions REPLICA IDENTITY FULL;

CREATE UNIQUE INDEX IF NOT EXISTS active_sessions_user_id_unique
ON public.active_sessions (user_id);

-- Beams: unique transaction id per loading cycle
ALTER TABLE public.beams
  ADD COLUMN IF NOT EXISTS transaction_id text;

UPDATE public.beams
  SET transaction_id = beam_no
  WHERE transaction_id IS NULL;

ALTER TABLE public.beams
  ALTER COLUMN transaction_id SET NOT NULL;

ALTER TABLE public.beams DROP CONSTRAINT IF EXISTS beams_pkey;
ALTER TABLE public.beams ADD CONSTRAINT beams_pkey PRIMARY KEY (transaction_id);

CREATE INDEX IF NOT EXISTS beams_beam_no_idx ON public.beams (beam_no);

-- Audit log attribution
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE POLICY "auth insert audit own"
ON public.audit_log
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

-- Beams: role-gated writes
CREATE POLICY "role update beams attributed"
ON public.beams
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'supervisor'::app_role)
  OR has_role(auth.uid(), 'shift_supervisor'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'loading_supervisor'::app_role)
  OR has_role(auth.uid(), 'dipping_supervisor'::app_role)
  OR has_role(auth.uid(), 'qc_inspector'::app_role)
)
WITH CHECK (updated_by = auth.uid());

CREATE POLICY "role insert beams attributed"
ON public.beams
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (updated_by IS NULL OR updated_by = auth.uid())
  AND (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'supervisor'::app_role)
    OR has_role(auth.uid(), 'shift_supervisor'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'loading_supervisor'::app_role)
  )
);

CREATE OR REPLACE FUNCTION public.validate_beam_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  is_privileged boolean;
BEGIN
  is_privileged :=
    has_role(uid, 'admin'::app_role)
    OR has_role(uid, 'supervisor'::app_role)
    OR has_role(uid, 'shift_supervisor'::app_role)
    OR has_role(uid, 'manager'::app_role);

  IF is_privileged THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT has_role(uid, 'loading_supervisor'::app_role) THEN
      RAISE EXCEPTION 'Forbidden: only loading roles may create beams';
    END IF;
    IF NEW.status <> 'LOADED' THEN
      RAISE EXCEPTION 'Forbidden: new beams must start in LOADED status';
    END IF;
    RETURN NEW;
  END IF;

  IF has_role(uid, 'loading_supervisor'::app_role) THEN
    IF OLD.status <> 'LOADED' OR NEW.status <> 'LOADED' THEN
      RAISE EXCEPTION 'Forbidden: loading role can only modify LOADED beams';
    END IF;
    RETURN NEW;
  END IF;

  IF has_role(uid, 'dipping_supervisor'::app_role) THEN
    IF OLD.status NOT IN ('LOADED','DIPPING') THEN
      RAISE EXCEPTION 'Forbidden: dipping role cannot modify beam in status %', OLD.status;
    END IF;
    IF NEW.status NOT IN ('DIPPING','QC_PENDING') THEN
      RAISE EXCEPTION 'Forbidden: dipping role cannot set status to %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF has_role(uid, 'qc_inspector'::app_role) THEN
    IF OLD.status NOT IN ('QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: QC role cannot modify beam in status %', OLD.status;
    END IF;
    IF NEW.status NOT IN ('QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: QC role cannot set status to %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Forbidden: caller has no role authorized to modify beams';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_beam_status_transition() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_beam_status ON public.beams;
CREATE TRIGGER trg_validate_beam_status
BEFORE INSERT OR UPDATE ON public.beams
FOR EACH ROW
EXECUTE FUNCTION public.validate_beam_status_transition();