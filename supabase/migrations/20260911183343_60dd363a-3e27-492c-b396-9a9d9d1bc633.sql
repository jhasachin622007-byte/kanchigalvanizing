DROP POLICY IF EXISTS "beam_bucket_select" ON storage.objects;
DROP POLICY IF EXISTS "beam_bucket_insert" ON storage.objects;
DROP POLICY IF EXISTS "beam_bucket_update" ON storage.objects;
DROP POLICY IF EXISTS "beam_bucket_delete" ON storage.objects;

CREATE POLICY "beam_bucket_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'beam'
    AND (
      public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'manager'::public.app_role)
      OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'loading_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'qc_inspector'::public.app_role)
    )
  );

CREATE POLICY "beam_bucket_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'beam'
    AND owner = auth.uid()
    AND (
      public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'manager'::public.app_role)
      OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'loading_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'qc_inspector'::public.app_role)
    )
  );

CREATE POLICY "beam_bucket_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'beam' AND (owner = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role)))
  WITH CHECK (bucket_id = 'beam' AND (owner = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role)));

CREATE POLICY "beam_bucket_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'beam' AND (owner = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role)));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','user_roles','audit_log','active_sessions'] LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='beams') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.beams';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='app_settings') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings';
  END IF;
END $$;

ALTER TABLE public.beams REPLICA IDENTITY FULL;
ALTER TABLE public.audit_log REPLICA IDENTITY FULL;
ALTER TABLE public.app_settings REPLICA IDENTITY FULL;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS "authenticated can subscribe to allowed topics" ON realtime.messages';
  EXECUTE $p$CREATE POLICY "authenticated can subscribe to allowed topics"
    ON realtime.messages FOR SELECT TO authenticated
    USING ((realtime.topic() LIKE 'realtime:public:beams%') OR (realtime.topic() LIKE 'realtime:public:app_settings%'))$p$;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'realtime.messages policy skipped: %', SQLERRM;
END $$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

DROP POLICY IF EXISTS "role insert beams attributed" ON public.beams;
DROP POLICY IF EXISTS "role update beams attributed" ON public.beams;

CREATE POLICY "role insert beams attributed"
ON public.beams FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (updated_by IS NULL OR updated_by = auth.uid())
  AND (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'supervisor'::app_role)
    OR has_role(auth.uid(), 'shift_supervisor'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR (has_role(auth.uid(), 'loading_supervisor'::app_role) AND status = 'LOADED')
  )
);

CREATE POLICY "role update beams attributed"
ON public.beams FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'supervisor'::app_role)
  OR has_role(auth.uid(), 'shift_supervisor'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR (has_role(auth.uid(), 'loading_supervisor'::app_role) AND status = 'LOADED')
  OR (has_role(auth.uid(), 'dipping_supervisor'::app_role) AND status = ANY (ARRAY['LOADED','DIPPING','QC_PENDING','COMPLETED']))
  OR (has_role(auth.uid(), 'qc_inspector'::app_role) AND status = ANY (ARRAY['QC_PENDING','COMPLETED']))
)
WITH CHECK (
  updated_by = auth.uid() AND (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'supervisor'::app_role)
    OR has_role(auth.uid(), 'shift_supervisor'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR (has_role(auth.uid(), 'loading_supervisor'::app_role) AND status = 'LOADED')
    OR (has_role(auth.uid(), 'dipping_supervisor'::app_role) AND status = ANY (ARRAY['DIPPING','QC_PENDING','COMPLETED']))
    OR (has_role(auth.uid(), 'qc_inspector'::app_role) AND status = ANY (ARRAY['QC_PENDING','COMPLETED']))
  )
);

CREATE OR REPLACE FUNCTION public.validate_beam_status_transition()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  is_privileged boolean;
BEGIN
  is_privileged :=
    has_role(uid, 'admin'::app_role)
    OR has_role(uid, 'supervisor'::app_role)
    OR has_role(uid, 'shift_supervisor'::app_role)
    OR has_role(uid, 'manager'::app_role);

  IF is_privileged THEN RETURN NEW; END IF;

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
    IF OLD.status NOT IN ('LOADED','DIPPING','QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: dipping role cannot modify beam in status %', OLD.status;
    END IF;
    IF NEW.status NOT IN ('DIPPING','QC_PENDING','COMPLETED') THEN
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
$function$;

REVOKE EXECUTE ON FUNCTION public.validate_beam_status_transition() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_beam_status ON public.beams;
CREATE TRIGGER trg_validate_beam_status
BEFORE INSERT OR UPDATE ON public.beams
FOR EACH ROW EXECUTE FUNCTION public.validate_beam_status_transition();

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _is_first boolean;
  _meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
BEGIN
  INSERT INTO public.profiles (id, email, full_name, username)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(_meta->>'full_name', NEW.email),
    COALESCE(_meta->>'username', split_part(NEW.email,'@',1))
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT NOT EXISTS(SELECT 1 FROM public.user_roles) INTO _is_first;

  IF _is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END $function$;

DROP POLICY IF EXISTS "auth insert audit own" ON public.audit_log;
CREATE POLICY "admin or manager insert audit"
ON public.audit_log FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() IS NOT NULL
  AND user_id = auth.uid()
  AND (public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'manager'::public.app_role))
);

CREATE TABLE public.beam_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id text NOT NULL,
  beam_no text NOT NULL,
  route_card_no text,
  part_no text,
  quantity integer,
  coating_spec text,
  qc_status text NOT NULL DEFAULT 'OFFERED' CHECK (qc_status IN ('OFFERED','ACCEPTED','REJECTED','DISPUTE')),
  defect_type text CHECK (defect_type IS NULL OR defect_type IN ('LUMPS','RUNS','STEEL_DEFECT','BARE_SPOT','ROUGH','OTHER')),
  defect_remark text,
  offered_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  decided_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX beam_materials_txn_idx ON public.beam_materials(transaction_id);
CREATE INDEX beam_materials_status_offered_idx ON public.beam_materials(qc_status, offered_at DESC);
CREATE UNIQUE INDEX beam_materials_uniq ON public.beam_materials(transaction_id, COALESCE(route_card_no,''), COALESCE(part_no,''));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.beam_materials TO authenticated;
GRANT ALL ON public.beam_materials TO service_role;

ALTER TABLE public.beam_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read beam_materials"
  ON public.beam_materials FOR SELECT TO authenticated USING (true);

CREATE POLICY "privileged insert beam_materials"
  ON public.beam_materials FOR INSERT TO authenticated
  WITH CHECK (
    (decided_by IS NULL OR decided_by = auth.uid())
    AND (
      has_role(auth.uid(),'admin'::app_role)
      OR has_role(auth.uid(),'supervisor'::app_role)
      OR has_role(auth.uid(),'shift_supervisor'::app_role)
      OR has_role(auth.uid(),'manager'::app_role)
      OR has_role(auth.uid(),'dipping_supervisor'::app_role)
      OR has_role(auth.uid(),'qc_inspector'::app_role)
    )
  );

CREATE POLICY "privileged update beam_materials"
  ON public.beam_materials FOR UPDATE TO authenticated
  USING (
    has_role(auth.uid(),'admin'::app_role)
    OR has_role(auth.uid(),'supervisor'::app_role)
    OR has_role(auth.uid(),'shift_supervisor'::app_role)
    OR has_role(auth.uid(),'manager'::app_role)
    OR has_role(auth.uid(),'qc_inspector'::app_role)
  )
  WITH CHECK (decided_by IS NULL OR decided_by = auth.uid());

CREATE POLICY "admin delete beam_materials"
  ON public.beam_materials FOR DELETE TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role));

CREATE OR REPLACE FUNCTION public.touch_beam_materials_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_beam_materials_updated_at
  BEFORE UPDATE ON public.beam_materials
  FOR EACH ROW EXECUTE FUNCTION public.touch_beam_materials_updated_at();

CREATE TABLE public.part_prefix_micron (
  prefix text PRIMARY KEY CHECK (char_length(prefix) = 3 AND prefix = upper(prefix)),
  coating_required integer NOT NULL CHECK (coating_required IN (65, 87, 130)),
  locked boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.part_prefix_micron TO authenticated;
GRANT ALL ON public.part_prefix_micron TO service_role;

ALTER TABLE public.part_prefix_micron ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read prefix defaults"
  ON public.part_prefix_micron FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert unlocked prefix defaults"
  ON public.part_prefix_micron FOR INSERT TO authenticated
  WITH CHECK (locked = false OR public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can update unlocked prefix defaults"
  ON public.part_prefix_micron FOR UPDATE TO authenticated
  USING (locked = false OR public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (locked = false OR public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete prefix defaults"
  ON public.part_prefix_micron FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_part_prefix_micron_updated_at
  BEFORE UPDATE ON public.part_prefix_micron
  FOR EACH ROW EXECUTE FUNCTION public.touch_beam_materials_updated_at();