import { Request, Response } from 'express';
import axios from 'axios';
import { pool } from '../db';

const WONCA_API_KEY = "bNamHEjNg2ibpZgOkZDNHuGbuoVhvMap-X_MZKDK20U";
const API_LIMIT = 1000;

// =======================================================
// CACHE: Definido para 2 horas (em segundos)
// 60 segundos * 60 minutos * 2 horas = 7200 segundos
// =======================================================
const CACHE_TTL_SECONDS = 7200; 

export const trackPackage = async (req: Request, res: Response) => {
    const { code } = req.params;

    if (!code) {
        return res.status(400).json({ error: 'Código de rastreio é obrigatório.' });
    }

    try {
        // =======================================================
        // 1. GESTÃO DE LIMITES DA API (Mantido do original)
        // =======================================================
        let usageCount = 0;
        const client = await pool.connect();
        try {
            const resUsage = await client.query(`
                SELECT request_count, EXTRACT(MONTH FROM last_reset) as reset_month, EXTRACT(MONTH FROM CURRENT_TIMESTAMP) as curr_month 
                FROM api_usage WHERE api_name = 'seu_rastreio'
            `);
            if (resUsage.rows.length > 0) {
                const usage = resUsage.rows[0];
                if (usage.reset_month !== usage.curr_month) {
                    await client.query(`UPDATE api_usage SET request_count = 0, last_reset = CURRENT_TIMESTAMP WHERE api_name = 'seu_rastreio'`);
                    usageCount = 0;
                } else {
                    usageCount = usage.request_count;
                }
            } else {
                await client.query(`INSERT INTO api_usage (api_name, request_count, last_reset) VALUES ('seu_rastreio', 0, CURRENT_TIMESTAMP)`);
            }
        } catch (dbErr) {
            console.log('[Tracking] Erro ao ler limite DB:', dbErr);
        } finally { 
            client.release(); 
        }

        // =======================================================
        // 2. VERIFICAÇÃO DO CACHE NO BANCO DE DADOS
        // =======================================================
        try {
            // Pedimos os dados e também calculamos a "idade" do registro em segundos diretamente no Postgres
            const cacheRes = await pool.query(`
                SELECT data, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - updated_at)) AS age_seconds 
                FROM tracking_cache 
                WHERE code = $1
            `, [code]);

            if (cacheRes.rows.length > 0) {
                const row = cacheRes.rows[0];
                
                // Se a idade for menor que as nossas 2 horas, o cache é válido!
                if (row.age_seconds < CACHE_TTL_SECONDS) {
                    console.log(`[Tracking] Código ${code} resgatado do Banco de Dados! (Válido por 2h) ⚡`);
                    return res.status(200).json({ ...row.data, usage: { count: usageCount, limit: API_LIMIT } });
                } else {
                    console.log(`[Tracking] Cache para ${code} expirou. Buscando dados novos...`);
                }
            }
        } catch (dbCacheErr) {
            console.log('[Tracking] Erro ao tentar ler o cache do Banco de Dados:', dbCacheErr);
        }

        let eventosFormatados: any[] = [];
        let encontrouDados = false;

        // =======================================================
        // TENTATIVA 1: WONCA LABS (POST)
        // =======================================================
        if (usageCount < API_LIMIT) {
            try {
                console.log(`[Tracking] Consultando Wonca Labs para: ${code}`);
                
                const url = `https://api-labs.wonca.com.br/wonca.labs.v1.LabsService/Track`;
                
                const resWonca = await axios.post(url, 
                    { code: code }, 
                    {
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': `Apikey ${WONCA_API_KEY}`,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                        },
                        timeout: 15000
                    }
                );

                if (resWonca.status === 200) {
                    const data = resWonca.data;
                    
                    const incClient = await pool.connect();
                    try {
                        await incClient.query(`UPDATE api_usage SET request_count = request_count + 1 WHERE api_name = 'seu_rastreio'`);
                        usageCount += 1;
                    } catch (e) {} finally { incClient.release(); }

                    let parsedData = data;
                    if (data && typeof data.json === 'string') {
                        try {
                            parsedData = JSON.parse(data.json);
                        } catch (e) {
                            console.log('[Tracking] Erro ao decodificar a string JSON da Wonca.');
                        }
                    }

                    // CAÇADOR INTELIGENTE DE EVENTOS
                    let rawEvents: any[] = [];
                    
                    if (Array.isArray(parsedData)) rawEvents = parsedData;
                    else if (parsedData.events && Array.isArray(parsedData.events)) rawEvents = parsedData.events;
                    else if (parsedData.eventos && Array.isArray(parsedData.eventos)) rawEvents = parsedData.eventos;
                    else if (parsedData.historico && Array.isArray(parsedData.historico)) rawEvents = parsedData.historico;

                    if (rawEvents.length > 0) {
                        eventosFormatados = rawEvents.map((evt: any) => {
                            let dtCriado = new Date().toISOString();
                            if (evt.dtHrCriado && evt.dtHrCriado.date) {
                                dtCriado = evt.dtHrCriado.date.replace(' ', 'T') + 'Z';
                            } else if (evt.data || evt.date || evt.dataHora) {
                                dtCriado = evt.data || evt.date || evt.dataHora;
                            } else if (typeof evt.dtHrCriado === 'string') {
                                dtCriado = evt.dtHrCriado;
                            }

                            let cidadeStr = "Desconhecido";
                            let ufStr = "";
                            let tipoLocal = "Local";

                            if (evt.unidade && evt.unidade.endereco) {
                                cidadeStr = evt.unidade.endereco.cidade || "Desconhecido";
                                ufStr = evt.unidade.endereco.uf || "";
                                tipoLocal = evt.unidade.tipo || "Local";
                            } else {
                                cidadeStr = evt.local || evt.location || evt.cidade || evt.city || "Desconhecido";
                                ufStr = evt.uf || evt.state || "";
                                if (cidadeStr.includes('/')) {
                                    const parts = cidadeStr.split('/');
                                    cidadeStr = parts[0].trim();
                                    ufStr = parts[1].trim();
                                }
                            }

                            let destinoFinal: any = null;
                            
                            if (evt.unidadeDestino && evt.unidadeDestino.endereco) {
                                destinoFinal = {
                                    tipo: evt.unidadeDestino.tipo || "Destino",
                                    endereco: {
                                        cidade: evt.unidadeDestino.endereco.cidade || "",
                                        uf: evt.unidadeDestino.endereco.uf || ""
                                    }
                                };
                            } else if (evt.destino || evt.destination) {
                                destinoFinal = {
                                    tipo: "Destino",
                                    endereco: { cidade: evt.destino || evt.destination, uf: "" }
                                };
                            }

                            let detalhes = evt.detalhe ? ` - ${evt.detalhe}` : "";

                            return {
                                descricao: (evt.descricao || evt.status || "Status atualizado") + detalhes,
                                dtHrCriado: dtCriado,
                                unidade: { 
                                    tipo: tipoLocal, 
                                    endereco: { cidade: cidadeStr, uf: ufStr } 
                                },
                                unidadeDestino: destinoFinal
                            };
                        });
                        
                        encontrouDados = true;
                        console.log(`[Tracking] Encomenda encontrada e processada com sucesso!`);
                    } else {
                        console.log(`[Tracking] Encomenda ainda não possui movimentações na base de dados.`);
                    }
                }
            } catch (error: any) { 
                console.log(`[Tracking] Falha na Wonca Labs: ${error.message}`); 
            }
        }

        // =======================================================
        // TENTATIVA 2: FALLBACK (Brasil API)
        // =======================================================
        if (!encontrouDados) {
            try {
                console.log(`[Tracking] Recorrendo ao Fallback BrasilAPI para: ${code}`);
                const resBrasil = await axios.get(`https://brasilapi.com.br/api/correios/v1/${code}`, { validateStatus: () => true, timeout: 8000 });

                if (resBrasil.status === 200 && resBrasil.data?.eventos?.length > 0) {
                    eventosFormatados = resBrasil.data.eventos.map((evt: any) => {
                        let dataIso = new Date().toISOString();
                        try {
                            if (evt.data && evt.hora) {
                                const [dia, mes, ano] = evt.data.split('/');
                                dataIso = `${ano}-${mes}-${dia}T${evt.hora}:00`;
                            }
                        } catch (e) {}
                        return {
                            descricao: evt.descricao || "Status atualizado",
                            dtHrCriado: dataIso,
                            unidade: { tipo: "Local", endereco: { cidade: evt.local || evt.cidade || "Desconhecido", uf: evt.uf || "" } },
                            unidadeDestino: null
                        };
                    });
                    encontrouDados = true;
                }
            } catch (error: any) {}
        }

        // =======================================================
        // RESPOSTA FINAL E SALVAMENTO NO BANCO DE DADOS
        // =======================================================
        if (!encontrouDados || eventosFormatados.length === 0) {
            return res.status(200).json({ eventos: [], usage: { count: usageCount, limit: API_LIMIT } });
        }

        const resultFinal = { eventos: eventosFormatados };
        
        // Vamos guardar ou atualizar os dados no nosso banco usando UPSERT
        try {
            await pool.query(`
                INSERT INTO tracking_cache (code, data, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP) 
                ON CONFLICT (code) DO UPDATE 
                SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(resultFinal)]);
            console.log(`[Tracking] Cache do código ${code} salvo/atualizado no DB! 💾`);
        } catch (saveErr: any) {
            console.error('[Tracking] Falha ao salvar no banco de dados:', saveErr.message);
        }

        return res.status(200).json({ ...resultFinal, usage: { count: usageCount, limit: API_LIMIT } });

    } catch (error: any) {
        console.error('[Tracking] Erro crítico geral:', error.message);
        return res.status(500).json({ error: 'Erro ao consultar os dados de rastreio.' });
    }
};
