public with sharing class WalletSetSelector {    
    public static Wallet_Set__c getWalletSetWithSeedPhrase(Id walletSetId) {
        return [
            SELECT Id, Wallet_Name__c, Seed_Phrase__c 
            FROM Wallet_Set__c 
            WHERE Id = :walletSetId 
            WITH SECURITY_ENFORCED 
            LIMIT 1
        ];
    }
}