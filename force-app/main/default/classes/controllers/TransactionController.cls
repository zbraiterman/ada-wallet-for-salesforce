/**
 * Controller for transaction-related operations
 * Provides methods for wallet loading, transaction management, and UTXO processing
 */
public with sharing class TransactionController {
    

    
    /**
     * Load wallet data with all addresses and assets
     * @param walletId The wallet ID to load
     * @return Map containing receiving addresses, change addresses, and wallet summary
     */
    @AuraEnabled
    public static Map<String, Object> loadWallet(String walletId) {
        try {
            List<UTXO_Address__c> utxoAddresses = UTXOAddressSelector.getAddressesByWalletId(walletId);
            
            WalletData walletData = processWalletAddresses(utxoAddresses);
            
            return new Map<String, Object>{
                'receivingAddresses' => walletData.receivingAddresses,
                'changeAddresses' => walletData.changeAddresses,
                'walletSummary' => buildWalletSummary(walletData)
            };
            
        } catch (Exception e) {
            throw new AuraHandledException('Error loading wallet: ' + e.getMessage());
        }
    }
    
    /**
     * Get epoch parameters from Blockfrost
     * @return String JSON response with epoch parameters
     */
    @AuraEnabled(cacheable=false)
    public static String getEpochParameters() {
        return BlockfrostService.getEpochParameters();
    }

    /**
     * Get transaction lines for an outbound transaction
     * @param outboundTransactionId The outbound transaction ID
     * @return List of transaction lines
     */
    @AuraEnabled(cacheable=true)
    public static List<Outbound_Transaction_Line__c> getTransactionLinesForOutbound(String outboundTransactionId) {
        try {
            return OutboundTransactionLineSelector.getTransactionLinesByOutboundId(outboundTransactionId);
        } catch (Exception e) {
            throw new AuraHandledException('Error fetching transaction lines: ' + e.getMessage());
        }
    }

    /**
     * Get outbound transaction by ID
     * @param outboundTransactionId The outbound transaction ID
     * @return Outbound transaction record
     */
    @AuraEnabled(cacheable=true)
    public static Outbound_Transaction__c getOutboundTransaction(String outboundTransactionId) {
        try {
            List<Outbound_Transaction__c> results = OutboundTransactionSelector.getOutboundTransactionById(outboundTransactionId);
            
            if (results.isEmpty()) {
                throw new AuraHandledException(ConstantsAda.ERROR_OUTBOUND_TX_NOT_FOUND);
            }
            
            return results[0];
        } catch (Exception e) {
            throw new AuraHandledException('Failed to fetch Outbound Transaction: ' + e.getMessage());
        }
    }

    /**
     * Update outbound transaction with signed CBOR
     * @param recordId The transaction record ID
     * @param signedCbor The signed CBOR transaction
     */
    @AuraEnabled
    public static void updateOutboundTransactionWithSignedCbor(String recordId, String signedCbor) {
        try {
            validateUpdateInput(recordId, signedCbor);
            
            List<Outbound_Transaction__c> txList = OutboundTransactionSelector.getOutboundTransactionById(recordId);
            if (txList.isEmpty()) {
                throw new AuraHandledException(ConstantsAda.ERROR_OUTBOUND_TX_NOT_FOUND);
            }
            
            updateTransactionWithCbor(txList[0], signedCbor);
        } catch (Exception e) {
            throw new AuraHandledException('Error updating outbound transaction: ' + e.getMessage());
        }
    }
    
    // =============================================================================
    // PRIVATE HELPER METHODS
    // =============================================================================
    
    /**
     * Validate input parameters for transaction update
     */
    private static void validateUpdateInput(String recordId, String signedCbor) {
        if (String.isBlank(recordId)) {
            throw new AuraHandledException(ConstantsAda.ERROR_RECORD_ID_REQUIRED);
        }
        if (String.isBlank(signedCbor)) {
            throw new AuraHandledException(ConstantsAda.ERROR_SIGNED_CBOR_REQUIRED);
        }
    }
    
    /**
     * Update transaction with signed CBOR
     */
    private static void updateTransactionWithCbor(Outbound_Transaction__c tx, String signedCbor) {
        if (!Schema.sObjectType.Outbound_Transaction__c.isUpdateable() ||
            !Schema.sObjectType.Outbound_Transaction__c.fields.Signed_Transaction_CBOR__c.isUpdateable() ||
            !Schema.sObjectType.Outbound_Transaction__c.fields.Transaction_Status__c.isUpdateable()) {
            throw new AuraHandledException('Insufficient permissions to update transaction');
        }
        
        tx.Signed_Transaction_CBOR__c = signedCbor;
        tx.Transaction_Status__c = ConstantsAda.STATUS_READY_TO_SEND;
        update tx;
    }
    
    /**
     * Process wallet addresses and collect data
     */
    private static WalletData processWalletAddresses(List<UTXO_Address__c> utxoAddresses) {
        List<Map<String, Object>> receivingAddresses = new List<Map<String, Object>>();
        List<Map<String, Object>> changeAddresses = new List<Map<String, Object>>();

        Decimal totalLovelace = 0;
        Integer addressesWithFunds = 0;
        Map<String, Decimal> assetTotals = new Map<String, Decimal>();

        Boolean hasAccessToDecrypt = EncryptedDataService.hasAccessToDecrypt('Ada_Wallet_Payment');

        for (UTXO_Address__c addr : utxoAddresses) {
            Map<String, Object> addressData = processAddress(addr, hasAccessToDecrypt);

            if (ConstantsAda.ADDRESS_TYPE_RECEIVING.equals(addr.Type__c)) {
                receivingAddresses.add(addressData);
            } else if (ConstantsAda.ADDRESS_TYPE_CHANGE.equals(addr.Type__c)) {
                changeAddresses.add(addressData);
            }

            updateWalletTotals(addressData, assetTotals, totalLovelace, addressesWithFunds);
        }

        return new WalletData(receivingAddresses, changeAddresses, assetTotals, totalLovelace, addressesWithFunds, utxoAddresses.size());
    }

    /**
     * Update wallet totals from address data
     */
    private static void updateWalletTotals(Map<String, Object> addressData, Map<String, Decimal> assetTotals, 
                                        Decimal totalLovelace, Integer addressesWithFunds) {
        String balanceStr = (String) ((Map<String, Object>) addressData.get('balance')).get('lovelace');
        Decimal addressBalance = Decimal.valueOf(balanceStr);
        
        if (addressBalance > 0) {
            totalLovelace += addressBalance;
            addressesWithFunds++;
        }
        
        List<Object> utxos = (List<Object>) addressData.get('utxos');
        collectAssetTotals(utxos, assetTotals);
    }
    
    /**
     * Build wallet summary from processed data
     */
    private static Map<String, Object> buildWalletSummary(WalletData walletData) {
        List<Map<String, Object>> assetsList = buildAssetsList(walletData.assetTotals);
        
        return new Map<String, Object>{
            'totalBalance' => new Map<String, Object>{
                'lovelace' => String.valueOf(walletData.totalLovelace),
                'ada' => String.valueOf(walletData.totalLovelace / ConstantsAda.LOVELACE_TO_ADA_RATIO),
                'assets' => assetsList
            },
            'totalAddresses' => walletData.totalAddresses,
            'addressesWithFunds' => walletData.addressesWithFunds
        };
    }
    
    /**
     * Process individual address and get UTXO data
     */
    private static Map<String, Object> processAddress(UTXO_Address__c addr, Boolean hasAccessToDecrypt) {
        Decimal addressLovelace = 0;
        List<Object> addressUtxos = new List<Object>();

        try {
            String utxosJson = BlockfrostService.getAddressUtxos(addr.Address__c);
            List<Object> utxos = (List<Object>) JSON.deserializeUntyped(utxosJson);

            if (utxos != null && !utxos.isEmpty()) {
                addressUtxos = utxos;
                addressLovelace = calculateLovelaceFromUtxos(utxos);
            }
        } catch (Exception e) {
            // UTXOs will remain empty if API call fails
        }

        return new Map<String, Object>{
            'index' => Integer.valueOf(addr.Index__c),
            'address' => addr.Address__c,
            'paymentKeyHash' => String.isNotBlank(addr.Payment_Key_Hash__c) && hasAccessToDecrypt ? DataEncryptor.decrypt(addr.Payment_Key_Hash__c) : '',
            'privateKey' => String.isNotBlank(addr.Private_Key__c) && hasAccessToDecrypt ? DataEncryptor.decrypt(addr.Private_Key__c) : '',
            'keyMatch' => true,
            'utxos' => addressUtxos,
            'balance' => new Map<String, Object>{
                'lovelace' => String.valueOf(addressLovelace)
            },
            'transactionCount' => addressUtxos.size()
        };
    }
    
    /**
     * Calculate total lovelace from UTXOs
     */
    @TestVisible
    private static Decimal calculateLovelaceFromUtxos(List<Object> utxos) {
        Decimal totalLovelace = 0;
        
        for (Object utxoObj : utxos) {
            Map<String, Object> utxo = (Map<String, Object>) utxoObj;
            List<Object> amounts = (List<Object>) utxo.get('amount');
            
            if (amounts != null) {
                for (Object amountObj : amounts) {
                    Map<String, Object> amount = (Map<String, Object>) amountObj;
                    String unit = (String) amount.get('unit');
                    String quantity = (String) amount.get('quantity');
                    
                    if (ConstantsAda.ASSET_LOVELACE.equals(unit) && String.isNotBlank(quantity)) {
                        totalLovelace += Decimal.valueOf(quantity);
                    }
                }
            }
        }
        
        return totalLovelace;
    }
    
    /**
     * Collect asset totals from UTXOs
     */
    @TestVisible
    private static void collectAssetTotals(List<Object> utxos, Map<String, Decimal> assetTotals) {
        for (Object utxoObj : utxos) {
            Map<String, Object> utxo = (Map<String, Object>) utxoObj;
            List<Object> amounts = (List<Object>) utxo.get('amount');
            
            if (amounts != null) {
                for (Object amountObj : amounts) {
                    Map<String, Object> amount = (Map<String, Object>) amountObj;
                    String unit = (String) amount.get('unit');
                    String quantity = (String) amount.get('quantity');
                    
                    if (!ConstantsAda.ASSET_LOVELACE.equals(unit) && String.isNotBlank(unit) && String.isNotBlank(quantity)) {
                        Decimal currentTotal = assetTotals.get(unit);
                        if (currentTotal == null) {
                            currentTotal = 0;
                        }
                        currentTotal += Decimal.valueOf(quantity);
                        assetTotals.put(unit, currentTotal);
                    }
                }
            }
        }
    }
    
    /**
     * Build assets list with metadata
     */
    @TestVisible
    private static List<Map<String, Object>> buildAssetsList(Map<String, Decimal> assetTotals) {
        List<Map<String, Object>> assetsList = new List<Map<String, Object>>();
        
        for (String unit : assetTotals.keySet()) {
            Map<String, Object> assetObj = createAssetObject(unit, assetTotals.get(unit));
            assetsList.add(assetObj);
        }
        
        return assetsList;
    }
    
    /**
     * Create asset object with metadata
     */
    @TestVisible
    private static Map<String, Object> createAssetObject(String unit, Decimal quantity) {
        Map<String, Object> assetObj = new Map<String, Object>{
            'unit' => unit,
            'quantity' => String.valueOf(quantity)
        };
        
        try {
            Map<String, Object> assetInfo = BlockfrostService.getAssetInfo(unit);
            populateAssetMetadata(assetObj, assetInfo);
        } catch (Exception e) {
            populateFallbackAssetMetadata(assetObj, unit);
        }
        
        return assetObj;
    }
    
    /**
     * Populate asset metadata from Blockfrost response
     */
    @TestVisible
    private static void populateAssetMetadata(Map<String, Object> assetObj, Map<String, Object> assetInfo) {
        if (assetInfo == null) {
            return;
        }
        
        assetObj.put('policyId', getStringValue(assetInfo, 'policy_id', ''));
        assetObj.put('assetName', getStringValue(assetInfo, 'asset_name', ''));
        assetObj.put('fingerprint', getStringValue(assetInfo, 'fingerprint', ''));
        
        Object metadataObj = assetInfo.get('metadata');
        if (metadataObj instanceof Map<String, Object>) {
            Map<String, Object> metadata = (Map<String, Object>) metadataObj;
            populateMetadataFields(assetObj, metadata);
        } else {
            populateDefaultMetadata(assetObj);
        }
    }
    
    /**
     * Populate metadata fields from metadata object
     */
    @TestVisible
    private static void populateMetadataFields(Map<String, Object> assetObj, Map<String, Object> metadata) {
        Object decimalsObj = metadata.get('decimals');
        if (decimalsObj != null) {
            assetObj.put('decimals', Integer.valueOf(String.valueOf(decimalsObj)));
        } else {
            assetObj.put('decimals', 0);
        }
        
        String assetName = (String) assetObj.get('assetName');
        assetObj.put('ticker', getStringValue(metadata, 'ticker', assetName));
        assetObj.put('description', getStringValue(metadata, 'description', ''));
    }
    
    /**
     * Populate default metadata when metadata is not available
     */
    @TestVisible
    private static void populateDefaultMetadata(Map<String, Object> assetObj) {
        assetObj.put('decimals', 0);
        assetObj.put('ticker', (String) assetObj.get('assetName'));
        assetObj.put('description', '');
    }
    
    /**
     * Populate fallback asset metadata when API call fails
     */
    @TestVisible
    private static void populateFallbackAssetMetadata(Map<String, Object> assetObj, String unit) {
        assetObj.put('policyId', unit.length() >= 56 ? unit.substring(0, 56) : '');
        assetObj.put('assetName', unit.length() > 56 ? unit.substring(56) : unit);
        assetObj.put('fingerprint', 'asset' + unit.substring(0, Math.min(8, unit.length())));
        assetObj.put('decimals', 0);
        assetObj.put('ticker', unit.length() > 56 ? unit.substring(56) : unit);
        assetObj.put('description', '');
    }
    
    /**
     * Get string value from map with default
     */
    @TestVisible
    private static String getStringValue(Map<String, Object> dataMap, String fieldKey, String defaultVal) {
        Object fieldValue = dataMap.get(fieldKey);
        return fieldValue != null ? String.valueOf(fieldValue) : defaultVal;
    }
    
    /**
     * Helper class to hold wallet processing data
     */
    private class WalletData {
        public List<Map<String, Object>> receivingAddresses;
        public List<Map<String, Object>> changeAddresses;
        public Map<String, Decimal> assetTotals;
        public Decimal totalLovelace;
        public Integer addressesWithFunds;
        public Integer totalAddresses;
        
        public WalletData(List<Map<String, Object>> receivingAddresses, List<Map<String, Object>> changeAddresses,
                        Map<String, Decimal> assetTotals, Decimal totalLovelace, Integer addressesWithFunds, Integer totalAddresses) {
            this.receivingAddresses = receivingAddresses;
            this.changeAddresses = changeAddresses;
            this.assetTotals = assetTotals;
            this.totalLovelace = totalLovelace;
            this.addressesWithFunds = addressesWithFunds;
            this.totalAddresses = totalAddresses;
        }
    }
} 