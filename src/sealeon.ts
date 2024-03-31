// Find all our documentation at https://docs.near.org

// chain : NEAR
// token : USDC
// token decimal : 6

import { NearBindgen, near, call, view, UnorderedMap, NearPromise, Vector} from '../near-sdk-js/packages/near-sdk-js/lib';
import {signerAccountId} from '../near-sdk-js/packages/near-sdk-js/lib/api'

const NO_DEPOSIT: bigint = BigInt(0)
const CALL_GAS: bigint = BigInt("10000000000000");

const admin_address = "jijay-park.testnet";

const USDCTokenAddress = "usdc.fakes.testnet";
const USDCDecimals = 6;
const USDCMantissa = 10 ** 6;

interface RegisterServiceParams {
  uuid: string;
  price_per_minute_mantissa : number;
  end_timestamp : number;
}

enum ServiceStatus {
  STOPPED,
  RUNNING,
}

enum ServicePaymentStatus {
  NOT_PAYED,
  PAYED,
  TRANSFERED_TO_PROVIDER,
}

interface PayServiceParams {
  consumer_address: string;
  service_id : string;
  usage_minute: number;
  transfer_amount: string;
}

class Service {
  id: string;
  uuid : string;
  provider_address: string;
  price_per_minute_mantissa : number;
  // nano-second
  start_timestamp : bigint;
  // nano-second
  end_timestamp : number;
  serviceStatus : ServiceStatus;

  constructor(
    id : string,
    uuid: string,
    provider_address: string,
    price_per_minute_mantissa : number,
    start_timestamp : bigint,
    // CHECK: client에서 nano-second를 보내도록
    end_timestamp : number
  ) {
    this.id = id;
    this.uuid = uuid;
    this.provider_address = provider_address; 
    this.price_per_minute_mantissa = price_per_minute_mantissa;
    this.start_timestamp = start_timestamp;
    this.end_timestamp = end_timestamp;
    this.serviceStatus = ServiceStatus.RUNNING;
  }
}

class PayLog {
  pay_log_id : string;
  consumer_address: string;
  service_id : string;
  payed_usage_minute: number;
  payed_amount: number;
  dueTimestamp: bigint;
  createAt: bigint;

  constructor(
    pay_log_id: string,
    dueTimestamp: bigint,
    consumer_address: string,
    service_id: string,
    payed_amount: number,
    payed_usage_minute: number,
  ) {
    this.pay_log_id = pay_log_id;
    this.dueTimestamp = dueTimestamp;
    this.consumer_address = consumer_address;
    this.service_id = service_id;
    this.payed_amount = payed_amount;
    this.payed_usage_minute = payed_usage_minute;
    this.createAt = near.blockTimestamp();
  }
}

class UsageHistoryLog {
  service_id: string;
  pay_log_id: string
  usage_minute: number;
  createdAt: number;

  constructor(
    service_id: string,
    pay_log_id: string,
    usage_minute: number,
  ) {
    this.service_id = service_id;
    this.pay_log_id = pay_log_id;
    this.usage_minute = usage_minute;
    this.createdAt = Date.now();
  }
}

@NearBindgen({})
class Sealeon {
  // provider -> amount
  providerServiceLedger: UnorderedMap<number> = new UnorderedMap<number>('providerServiceLedger');
  // provider -> amount
  providerServiceEarned: UnorderedMap<number> = new UnorderedMap<number>('providerServiceEarned');
  // consumer_address -> using service
  consumerServiceMap: UnorderedMap<Service> = new UnorderedMap<Service>('consumerServiceMap');
  // service_list
  totalServiceList: Vector<Service> = new Vector<Service>('totalServiceList');
  // payLogs 
  payLogs: Vector<PayLog> = new Vector<PayLog>('payLogs');
  // payLogs 
  usageHistoryLogs: Vector<UsageHistoryLog> = new Vector<UsageHistoryLog>('usageHistoryLogs');
  // serviceId -> service
  serviceMap: UnorderedMap<Service> = new UnorderedMap<Service>('serviceMap');
  // platform 수수료
  platformFeeMap: UnorderedMap<bigint> = new UnorderedMap<bigint>('platformFeeMap');
  
  // provider가 서비스를 등록
  @call({}) // This method changes the state, for which it cost gas
  register_service({
    uuid,
    price_per_minute_mantissa,
    end_timestamp,
  }: RegisterServiceParams): void {
    near.log(`Registering Service`);

    const provider_address = signerAccountId();
    
    const serviceId = `${provider_address}_${this.totalServiceList.length}`;
    near.log(`serviceId: ${serviceId}`)
    
    const start_timestamp = near.blockTimestamp();
    near.log(`start_timestamp: ${start_timestamp}`);
    
    if(end_timestamp < start_timestamp) throw new Error("Invalid end_timestamp");
    
    near.log('Creating Service');

    const service = new Service(
      serviceId,
      uuid,
      provider_address,
      price_per_minute_mantissa,
      start_timestamp,
      end_timestamp
    );
    
    near.log('Service Created');
    
    this.serviceMap.set(serviceId, service);
    
    near.log(`serviceMap: ${this.serviceMap.length}`)

    this.totalServiceList.push(service);
    
    near.log(`Service Registered`);
    
    if(this.providerServiceLedger.get(provider_address) === null) {
      this.providerServiceLedger.set(provider_address, 0);
    }
    
    if(this.providerServiceEarned.get(provider_address) === null) {
      this.providerServiceEarned.set(provider_address, 0);
    }
  }
  
  @view({})
  get_admin_address(): string {
    return admin_address;
  }
  
  // consumer가 provider의 서비스를 결제 및 사용 시작
  @call({
    payableFunction: true
  })
  pay_service({service_id, usage_minute} : PayServiceParams) {
    near.log(`service_id: ${service_id}`);
    near.log(`usage_minute: ${usage_minute}`)

    const consumer_address = signerAccountId();
    const transfer_amount = near.attachedDeposit();
    
    if(!this.isAvailableService({service_id})) {
      near.log("Service is not available");
      throw new Error("Service is not available");
    }

    const preUsedService = this.get_service_by_consumer({consumer_address})

    if(preUsedService) {
      near.log("Already using service");
      throw new Error("Already using service");
    }
    
    const service = this.serviceMap.get(service_id);

    if(!service) {
      near.log("No service found");
      throw new Error("No service found");
    }
    
    const price_mantissa = service.price_per_minute_mantissa * usage_minute;
    
    near.log(`price_mantissa: ${price_mantissa}`)

    if(+transfer_amount.toString() < price_mantissa) {
      near.log("Insufficient transfer amount");
      throw new Error("Insufficient transfer amount");
    }
    
    const dueTimestamp = near.blockTimestamp() + this.minutesToNanoSeconds(usage_minute);
    
    near.log(`timestamp: ${near.blockTimestamp()}`);
    near.log(`dueTimestamp: ${dueTimestamp}`);
    
    const payLog = new PayLog(`${service.id}_${this.payLogs.length}`, dueTimestamp, consumer_address, service.id, Number(transfer_amount.toString()), usage_minute);
    
    near.log('before push payLog');

    this.payLogs.push(payLog);
    
    near.log('after push payLog');
    
    this.consumerServiceMap.set(consumer_address, service);
    
    near.log('after set consumerServiceMap');
    
    const ledger = this.providerServiceLedger.get(service.provider_address);
    
    if(!ledger) this.providerServiceLedger.set(service.provider_address, 0);

    near.log('before set providerLedger')

    this.providerServiceLedger.set(service.provider_address, ledger + price_mantissa);
    
    near.log('after set providerLedger')
    
    const refundAmount = BigInt(price_mantissa) - transfer_amount
    
    near.log(`refundAmount: ${refundAmount}`);
    NearPromise.new(consumer_address).transfer(refundAmount);
    
    near.log('after refundAmount')
  }
  

  // consumer가 서비스 사용 중지
  @call({})
  stop_use_service({service_id}) {
    const consumer_address = signerAccountId();

    const service = this.serviceMap.get(service_id);
    if(!service) throw new Error("No service found");
    
    const payLogList = this.payLogs.toArray().filter(l => l.service_id === service_id);
    const lastPayLog = payLogList[payLogList.length - 1];
    
    if(!lastPayLog) throw new Error("No payLog found");
    if(lastPayLog.consumer_address !== consumer_address) throw new Error("Not Authorized");
    
    near.log(`current: ${near.blockTimestamp()}`)
    near.log(`lastPayLog.dueTimestamp: ${lastPayLog.dueTimestamp}`)

    if(near.blockTimestamp() > lastPayLog.dueTimestamp) throw new Error("already ended");
    
    const pastUsageHistoryLog = this.usageHistoryLogs.toArray().find(l => l.pay_log_id === lastPayLog.pay_log_id);
    if(pastUsageHistoryLog) throw new Error("Already stopped");
    
    const usageMinute = this.nanoSecondsToMinutes((near.blockTimestamp() - lastPayLog.createAt));
    const leftMinute = this.nanoSecondsToMinutes(lastPayLog.createAt + this.minutesToNanoSeconds(lastPayLog.payed_usage_minute) - near.blockTimestamp()) 
    
    const usageHistoryLog = new UsageHistoryLog(service.id, lastPayLog.pay_log_id, usageMinute);
    this.usageHistoryLogs.push(usageHistoryLog);
    
    const refundAmount = service.price_per_minute_mantissa * leftMinute;
    
    NearPromise.new(consumer_address).transfer(BigInt(refundAmount));

    try {
      // 환불 성공
      const result = near.promiseResult(0);
      near.log(`Success!, result: ${result}`);
      lastPayLog.payed_amount = +(+lastPayLog.payed_amount.toString() - refundAmount).toString();

      const ledgerAmount = this.providerServiceLedger.get(service.provider_address);
      this.providerServiceLedger.set(service.provider_address, ledgerAmount - refundAmount);
    } catch {
      // 환불 실패
      near.log("Promise failed...")
    }
    
    this.consumerServiceMap.remove(consumer_address);
  }
  
  // provider가 서비스를 긴급 중지
  // TODO: consumer에게 환불 + provider에게 손해 배상
  @call({})
  stop_service_emergency({service_id}) {
    const provider_address = signerAccountId();
    const service = this.serviceMap.get(service_id);
    
    if(!service) throw new Error("No service found");
    if(service.provider_address !== provider_address) throw new Error("Not Authorized");
    
    const lastPayLog = this.payLogs.toArray().filter(l => l.service_id === service_id)[this.payLogs.length - 1]
    
    if(!lastPayLog) throw new Error("No payLog found");
    if(near.blockTimestamp() > lastPayLog.dueTimestamp) throw new Error("already ended");
    
    const pastUsageHistoryLog = this.usageHistoryLogs.toArray().find(l => l.pay_log_id === lastPayLog.pay_log_id);
    if(pastUsageHistoryLog) throw new Error("Already stopped");
    
    service.serviceStatus = ServiceStatus.STOPPED;
    
    if(!this.isAvailableService({service_id})) {
      // 환불
      const lastPayLog = this.payLogs.toArray().filter(l => l.service_id === service_id)[this.payLogs.length - 1]
      
      const usageMinute = this.nanoSecondsToMinutes((near.blockTimestamp() - lastPayLog.createAt));
      const leftMinute = this.nanoSecondsToMinutes(lastPayLog.createAt + this.minutesToNanoSeconds(lastPayLog.payed_usage_minute) - near.blockTimestamp()) 
      
      const usageHistoryLog = new UsageHistoryLog(service.id, lastPayLog.pay_log_id, usageMinute);
      this.usageHistoryLogs.push(usageHistoryLog);
      
      const refundAmount = service.price_per_minute_mantissa * leftMinute; 
      
      NearPromise.new(lastPayLog.consumer_address).transfer(BigInt(refundAmount));
      
      try {
        // 환불 성공
        const result = near.promiseResult(0);
        near.log(`Success!, result: ${result}`);
        lastPayLog.payed_amount = +(+lastPayLog.payed_amount - refundAmount).toString();
  
        const ledgerAmount = this.providerServiceLedger.get(service.provider_address);
        this.providerServiceLedger.set(service.provider_address, ledgerAmount - refundAmount);
      } catch {
        // 환불 실패
        near.log("Promise failed...")
      }
      
      // TODO: penalty
      this.consumerServiceMap.remove(lastPayLog.consumer_address);
    }

  }
  
  @view({})
  isAvailableService({service_id}): boolean {
    near.log(`available, service_id: ${service_id}`)
    // PayLog와 UsaugeHistoryLog를 확인하여 사용하지 않고 있는 서비스만 반환
    const service = this.serviceMap.get(service_id);
    
    if(!service) {
      near.log("No service found");
      return false;
    }
    if(service.serviceStatus === ServiceStatus.STOPPED){
      near.log("Service is stopped")
      return false
    }
    if(service.end_timestamp < near.blockTimestamp()){
      near.log("Service is already ended")
      return false
    }

    const payLogList = this.payLogs.toArray().filter(l => l.service_id === service_id);
    const lastPayLog = payLogList[payLogList.length - 1];
    
    if(!lastPayLog) {
      near.log("No payLog found");
      return true;
    }
    
    const pastUsageHistoryLog = this.usageHistoryLogs.toArray().find(l => l.pay_log_id === lastPayLog.pay_log_id);
    if(pastUsageHistoryLog) return true;

    if(lastPayLog.dueTimestamp > near.blockTimestamp()) {
      return false;
    }
    
    return false;
  }
  
  private nanoSecondsToMinutes(nanoSeconds: bigint): number {
    return +nanoSeconds.toString() / 60_000_000_000;
  }
  
  private minutesToNanoSeconds(minutes: number): bigint {
    return BigInt(minutes * 60_000_000_000);
  }
  
  @call({privateFunction: true})
  ft_transfer_callback(): boolean {
    let result, success;
  
    try{ result = near.promiseResult(0); success = true }
    catch{ result = undefined; success = false }
  
    if (success) {
      near.log(`Success!`)
      return true
    } else {
      near.log("Promise failed...")
      return false
    }
  }
  
  @view({})
  get_available_service_list(): Service[] {
    return this.totalServiceList.toArray().filter(s => {
      return this.isAvailableService({service_id: s.id})
    })
  }

  @view({})
  get_service_list(): Service[] {
    return this.totalServiceList.toArray().filter(s => {
      if(s.serviceStatus === ServiceStatus.STOPPED) return false;
      if(s.end_timestamp < near.blockTimestamp()) return false;
      return true;
    })
  }

  @view({})
  get_service_list_by_provider({provider_address}): Service[] {
    return this.totalServiceList.toArray().filter(s => {
      return s.provider_address === provider_address && s.end_timestamp > near.blockTimestamp()
    })
  }

  
  @view({})
  get_ledger_by_provider_address({provider_address}) {
    return this.providerServiceLedger.get(provider_address);
  }
  
  @view({})
  get_earned_by_provider_address({provider_address}) {
    return this.providerServiceEarned.get(provider_address);
  }
  
  @view({})
  get_pay_log_list(): PayLog[] {
    return this.payLogs.toArray();
  }

  @view({})
  get_accured_pay_amount({service_id}) {
    return this.payLogs.toArray().filter(l => l.service_id === service_id && l.dueTimestamp < near.blockTimestamp()).reduce((acc, cur) => acc + cur.payed_amount, 0);
  }
  
  @view({})
  get_service({service_id}): Service {
    return this.serviceMap.get(service_id);
  }
  
  @view({})
  get_service_by_consumer({consumer_address}): Service {
    const service = this.consumerServiceMap.get(consumer_address);
    const payLogList = this.payLogs.toArray().filter(l => l.service_id === service.id);
    const lastPayLog = payLogList[payLogList.length - 1]

    if(!lastPayLog) return null;
    if(!service) return null;

    if(service.end_timestamp < near.blockTimestamp()){
      near.log("Service is already ended")
      return null
    }    
    if(lastPayLog.dueTimestamp < near.blockTimestamp()) {
      near.log("Service is already ended")
      return null;
    }
    return service
  }
  
  @view({})
  get_pay_logs_by_service_id({service_id}): PayLog[] {
    return this.payLogs.toArray().filter(p => p.service_id === service_id);
  }
  
  @view({})
  get_usage_history_logs(): UsageHistoryLog[] {
    return this.usageHistoryLogs.toArray();
  }
  
  @view({})
  get_provider_service_ledger({provider_address}): number {
    return this.providerServiceLedger.get(provider_address);
  }
  

  @view({})
  get_all_service_list(){
    return this.totalServiceList;
  }
  
  // @call({})
  // ft_on_transfer(
  //   sender_id: string,
  //   amount: string,
  //   msg: string
  // ): string {
  //   const data = JSON.parse(msg);
    
  //   try {
  //     if(data.action === 'pay_service') {
  //       const { service_id, usage_minute } = data;
  //       const transfer_token_address = near.predecessorAccountId();
  //       if(transfer_token_address !== USDCTokenAddress) return amount;
  //       return this.pay_service({consumer_address: sender_id, service_id, usage_minute, transfer_amount: amount})
  //     } 
  //   } catch(e) {
  //     near.log(e);
  //     return amount;
  //   }
    
  //   return amount;
  // }
}