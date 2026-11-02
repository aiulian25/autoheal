import { z } from "zod";

// Configure before importing shared schemas: the dashboard forbids runtime code generation.
z.config({ jitless: true });
